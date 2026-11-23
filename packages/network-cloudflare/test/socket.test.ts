import { generateKeyPair } from "@afterpack/network-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Np1TestClient } from "../../network-core/test/np1-client.js";
import {
  createSocketProtection,
  HANDSHAKE_TIMEOUT_MS,
  PENDING_BYTES_LIMIT,
  PENDING_SEND_LIMIT,
  type ProtectedSocket,
  REFUSAL_CLOSE_CODE,
} from "../src/index.js";

class FakeSocket implements ProtectedSocket {
  sent: (string | Uint8Array)[] = [];
  closed: number | null = null;
  stored: string | null = null;
  send(message: string | ArrayBuffer | ArrayBufferView) {
    if (typeof message === "string") this.sent.push(message);
    else if (message instanceof ArrayBuffer) this.sent.push(new Uint8Array(message));
    else this.sent.push(new Uint8Array(message.buffer, message.byteOffset, message.byteLength));
  }
  close(code?: number) {
    this.closed = code ?? 1005;
  }
  serializeAttachment(value: unknown) {
    this.stored = JSON.stringify(value);
  }
  deserializeAttachment() {
    return this.stored === null ? null : JSON.parse(this.stored);
  }
}

class PlainSocket {
  sent: (string | Uint8Array)[] = [];
  closed: number | null = null;
  send(message: string | ArrayBuffer | ArrayBufferView) {
    this.sent.push(typeof message === "string" ? message : new Uint8Array(message as ArrayBuffer));
  }
  close(code?: number) {
    this.closed = code ?? 1005;
  }
}

function setup() {
  const pair = generateKeyPair();
  const serverPublic = new Uint8Array(Buffer.from(pair.publicKey, "base64url"));
  const sockets = createSocketProtection({ privateKeys: pair.privateKey });
  return { sockets, client: () => new Np1TestClient({ serverPublic, ratio: 2 }) };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createSocketProtection: the Durable Object socket helper", () => {
  for (const frameType of ["binary", "text"] as const) {
    it(`opens and seals a ${frameType} socket, buffering server sends until the handshake`, () => {
      const { sockets, client } = setup();
      const app = client();
      const socket = new FakeSocket();
      sockets.accept(socket, { seat: 3 });
      sockets.send(socket, "welcome");
      sockets.send(socket, new Uint8Array([1, 2]));
      expect(socket.sent).toEqual([]);

      const toWire = (frame: string | Uint8Array) =>
        typeof frame === "string" ? frame : (frame.buffer.slice(0) as ArrayBuffer);
      expect(sockets.receive(socket, toWire(app.socketFrame(null, frameType, true)))).toBeNull();
      expect(socket.sent.map((frame) => app.openSocketFrame(frame))).toEqual([
        "welcome",
        new Uint8Array([1, 2]),
      ]);

      expect(sockets.receive(socket, toWire(app.socketFrame("move", frameType, false)))).toBe(
        "move",
      );
      const binary = sockets.receive(
        socket,
        toWire(app.socketFrame(new Uint8Array([5, 6, 7]), frameType, false)),
      );
      expect(binary).toBeInstanceOf(ArrayBuffer);
      expect(new Uint8Array(binary as ArrayBuffer)).toEqual(new Uint8Array([5, 6, 7]));

      sockets.send(socket, "after");
      expect(app.openSocketFrame(socket.sent[2])).toBe("after");
      expect(sockets.attachment(socket)).toEqual({ seat: 3 });
      sockets.setAttachment(socket, { seat: 4 });
      expect(sockets.attachment(socket)).toEqual({ seat: 4 });
      expect(sockets.receive(socket, toWire(app.socketFrame("still", frameType, false)))).toBe(
        "still",
      );
      expect(socket.closed).toBeNull();

      vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS * 2);
      expect(socket.closed).toBeNull();
    });
  }

  it("keeps the session in the attachment, so a hibernated socket resumes", () => {
    const { sockets, client } = setup();
    const app = client();
    const socket = new FakeSocket();
    sockets.accept(socket);
    sockets.receive(socket, app.socketFrame("first", "text", true));
    const stored = socket.stored;

    const fresh = createSocketProtection(sockets.protection);
    const woken = new FakeSocket();
    woken.stored = stored;
    expect(fresh.receive(woken, app.socketFrame("after sleep", "text", false))).toBe("after sleep");
    fresh.send(woken, "reply");
    expect(app.openSocketFrame(woken.sent[0])).toBe("reply");
  });

  it("closes a socket that sends no handshake record within 10 seconds", () => {
    const { sockets } = setup();
    const socket = new FakeSocket();
    sockets.accept(socket);
    sockets.send(socket, "never sent");
    vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS - 1);
    expect(socket.closed).toBeNull();
    vi.advanceTimersByTime(1);
    expect(socket.closed).toBe(REFUSAL_CLOSE_CODE);
    expect(socket.sent).toEqual([]);
  });

  it("closes a socket whose first frame arrives after the deadline, as after hibernation", () => {
    const { sockets, client } = setup();
    const socket = new FakeSocket();
    sockets.accept(socket);
    const woken = createSocketProtection(sockets.protection);
    vi.setSystemTime(Date.now() + HANDSHAKE_TIMEOUT_MS + 1);
    expect(woken.receive(socket, client().socketFrame(null, "binary", true))).toBeNull();
    expect(socket.closed).toBe(REFUSAL_CLOSE_CODE);
  });

  it("closes on a frame that fails to open, with a code and no reason", () => {
    const { sockets, client } = setup();
    const socket = new FakeSocket();
    const close = vi.spyOn(socket, "close");
    sockets.accept(socket);
    expect(sockets.receive(socket, "not a record")).toBeNull();
    expect(close).toHaveBeenCalledWith(REFUSAL_CLOSE_CODE);

    const second = new FakeSocket();
    sockets.accept(second);
    const app = client();
    sockets.receive(second, app.socketFrame(null, "binary", true));
    expect(sockets.receive(second, app.socketFrame(null, "binary", false))).toBeNull();
    expect(second.closed).toBe(REFUSAL_CLOSE_CODE);
  });

  it("works on a socket without attachments", () => {
    const { sockets, client } = setup();
    const app = client();
    const socket = new PlainSocket();
    sockets.accept(socket, "data");
    sockets.send(socket, "queued");
    expect(sockets.receive(socket, app.socketFrame("hi", "text", true))).toBe("hi");
    expect(app.openSocketFrame(socket.sent[0])).toBe("queued");
    expect(sockets.attachment(socket)).toBe("data");
    vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS);
    expect(socket.closed).toBeNull();
  });

  it("drops sends to a socket it never accepted or already refused", () => {
    const { sockets, client } = setup();
    const stranger = new FakeSocket();
    sockets.send(stranger, "lost");
    expect(stranger.sent).toEqual([]);
    expect(stranger.closed).toBeNull();

    const late = new FakeSocket();
    sockets.accept(late);
    vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS);
    expect(late.closed).toBe(REFUSAL_CLOSE_CODE);
    sockets.send(late, "after refusal");
    expect(sockets.receive(late, client().socketFrame(null, "binary", true))).toBeNull();
    expect(late.sent).toEqual([]);

    const broken = new FakeSocket();
    sockets.accept(broken);
    sockets.receive(broken, "not a record");
    sockets.send(broken, "after a bad frame");
    vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS);
    expect(broken.sent).toEqual([]);
  });

  it("closes a socket whose buffered sends pass the cap before its first frame", () => {
    const { sockets } = setup();
    const many = new FakeSocket();
    sockets.accept(many);
    for (let i = 0; i < PENDING_SEND_LIMIT; i++) sockets.send(many, "x");
    expect(many.closed).toBeNull();
    sockets.send(many, "one too many");
    expect(many.closed).toBe(REFUSAL_CLOSE_CODE);

    const big = new FakeSocket();
    sockets.accept(big);
    sockets.send(big, new Uint8Array(PENDING_BYTES_LIMIT));
    expect(big.closed).toBeNull();
    sockets.send(big, new Uint8Array(1));
    expect(big.closed).toBe(REFUSAL_CLOSE_CODE);
    expect([...many.sent, ...big.sent]).toEqual([]);
  });

  it("re-arms the handshake deadline with restore after the object restarts", () => {
    const { sockets, client } = setup();
    const waiting = new FakeSocket();
    const done = new FakeSocket();
    const expired = new FakeSocket();
    sockets.accept(waiting);
    sockets.accept(done);
    sockets.receive(done, client().socketFrame(null, "text", true));
    expired.stored = waiting.stored;
    vi.clearAllTimers();
    vi.advanceTimersByTime(4_000);

    const restarted = createSocketProtection(sockets.protection);
    for (const socket of [waiting, done]) restarted.restore(socket);
    restarted.restore(waiting);
    vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS - 4_000 - 1);
    expect(waiting.closed).toBeNull();
    vi.advanceTimersByTime(1);
    expect(waiting.closed).toBe(REFUSAL_CLOSE_CODE);
    expect(done.closed).toBeNull();

    const again = createSocketProtection(sockets.protection);
    again.restore(expired);
    expect(expired.closed).toBe(REFUSAL_CLOSE_CODE);
    again.restore(new FakeSocket());
  });

  it("closes a socket it never accepted", () => {
    const { sockets, client } = setup();
    const socket = new FakeSocket();
    expect(sockets.receive(socket, client().socketFrame(null, "binary", true))).toBeNull();
    expect(socket.closed).toBe(REFUSAL_CLOSE_CODE);
  });
});
