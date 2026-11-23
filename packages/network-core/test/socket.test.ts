import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import type { SocketState } from "../src/index.js";
import { setup } from "./harness.js";
import { type FrameType, wireFromText } from "./np1-client.js";

const FRAME_TYPES: FrameType[] = ["binary", "text"];

function roundState(state: SocketState): SocketState {
  return JSON.parse(JSON.stringify(state));
}

describe("openSocket and sealSocket with the independent client", () => {
  for (const frameType of FRAME_TYPES) {
    it(`carries kinds 3 to 7 over ${frameType} frames, with the state serialised between frames`, () => {
      const { protection, client } = setup();
      const app = client(2);

      const handshake = protection.openSocket(null, app.socketFrame(null, frameType, true));
      expect(handshake).toMatchObject({ ok: true, message: null, state: { frameType } });
      if (!handshake.ok) return;
      let state = roundState(handshake.state);

      const text = protection.openSocket(
        state,
        app.socketFrame("move e2e4 — é 🌍", frameType, false),
      );
      expect(text).toMatchObject({ ok: true, message: "move e2e4 — é 🌍" });
      state = roundState(text.ok ? text.state : state);

      const payload = new Uint8Array([0, 1, 2, 255]);
      const binary = protection.openSocket(state, app.socketFrame(payload, frameType, false));
      expect(binary).toMatchObject({ ok: true, message: payload });

      const empty = protection.openSocket(
        state,
        app.socketFrame(new Uint8Array(0), frameType, false),
      );
      expect(empty).toMatchObject({ ok: true, message: new Uint8Array(0) });

      const serverText = protection.sealSocket(state, "welcome 🌍");
      expect(typeof serverText).toBe(frameType === "text" ? "string" : "object");
      expect(app.openSocketFrame(serverText)).toBe("welcome 🌍");

      const serverBinary = protection.sealSocket(state, new Uint8Array([9, 8, 7]).buffer);
      expect(app.openSocketFrame(serverBinary)).toEqual(new Uint8Array([9, 8, 7]));

      const view = new DataView(new Uint8Array([1, 2, 3, 4, 5]).buffer, 1, 3);
      expect(app.openSocketFrame(protection.sealSocket(state, view))).toEqual(
        new Uint8Array([2, 3, 4]),
      );
    });

    it(`takes the app's first message as the first ${frameType} frame`, () => {
      const { protection, client } = setup();
      const app = client(1.5);
      const first = protection.openSocket(undefined, app.socketFrame("hello", frameType, true));
      expect(first).toMatchObject({ ok: true, message: "hello" });
      const other = client(1.5);
      const firstBinary = protection.openSocket(
        null,
        other.socketFrame(new Uint8Array([7]), frameType, true),
      );
      expect(firstBinary).toMatchObject({ ok: true, message: new Uint8Array([7]) });
    });
  }

  it("pads server frames to the server ladder", () => {
    const { protection, client } = setup();
    const app = client();
    const opened = protection.openSocket(null, app.socketFrame(null, "text", true));
    if (!opened.ok) throw new Error("handshake");
    for (const [size, bucket] of [
      [1, 256],
      [600, 1024],
      [70_000, 131_072],
    ]) {
      const frame = protection.sealSocket(opened.state, new Uint8Array(size));
      const wire = wireFromText(frame as string);
      const inner = nacl.secretbox.open(wire.subarray(24), wire.subarray(0, 24), app.key);
      expect(inner?.length).toBe(bucket);
    }
  });

  it("refuses a handshake after the first frame, a switched frame type and a reflected frame", () => {
    const { protection, client } = setup();
    const app = client();
    const opened = protection.openSocket(null, app.socketFrame(null, "binary", true));
    if (!opened.ok) throw new Error("handshake");
    expect(
      protection.openSocket(opened.state, app.socketFrame(null, "binary", false)),
    ).toMatchObject({
      ok: false,
      error: "unexpected-handshake",
    });
    expect(protection.openSocket(opened.state, app.socketFrame("x", "text", false))).toMatchObject({
      ok: false,
      error: "bad-encoding",
    });
    const reflected = protection.sealSocket(opened.state, "echo");
    expect(protection.openSocket(opened.state, reflected)).toMatchObject({
      ok: false,
      error: "wrong-direction",
    });
    expect(protection.openSocket(null, app.socketFrame(null, "binary", false))).toMatchObject({
      ok: false,
    });
    expect(protection.counters.openFailures).toBe(4);
  });

  it("refuses a first frame sealed to another server", () => {
    const { protection } = setup();
    const stranger = setup().client();
    expect(protection.openSocket(null, stranger.socketFrame(null, "text", true))).toEqual({
      ok: false,
      error: "open-failed",
      state: null,
    });
  });

  it("seals nothing before the handshake and refuses a state it can't use", () => {
    const { protection } = setup();
    expect(() => protection.sealSocket(null as unknown as SocketState, "x")).toThrow(TypeError);
    expect(() => protection.sealSocket({ key: "short", frameType: "text" }, "x")).toThrow(
      TypeError,
    );
    expect(() =>
      protection.sealSocket({ key: "A".repeat(43), frameType: "carrier" as FrameType }, "x"),
    ).toThrow(TypeError);
  });
});
