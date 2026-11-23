import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fromBase64, fromBase64url, fromEitherBase64, toBase64, toBase64url } from "./bytes.js";
import { deriveSessionKey } from "./crypto.js";
import {
  type BodyEncoding,
  buildInner,
  detectBody,
  encodeBody,
  type InnerMessage,
  ladderBucket,
  openRecord,
  sealRecord,
} from "./np1.js";
import { createNetworkProtection } from "./protection.js";
import { deriveAll } from "./session-cache.js";

const v = JSON.parse(readFileSync(new URL("../vectors/np1.json", import.meta.url), "utf8"));
const h = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "hex"));
const x = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

type Rec = (typeof v.records)[number];
const recordById = new Map<string, Rec>(v.records.map((r: Rec) => [r.id, r]));

function prefixed(secrets: Uint8Array[]) {
  return {
    prefixed: (eph: Uint8Array) => {
      const keys = deriveAll(secrets, eph);
      return keys === "zero-shared" ? keys : { keys };
    },
  };
}

function fieldsOf(message: InnerMessage): Record<string, unknown> {
  switch (message.kind) {
    case 1:
      return {
        method: message.method,
        target: message.target,
        headers: message.headers,
        body: x(message.body),
      };
    case 2:
      return { status: message.status, headers: message.headers, body: x(message.body) };
    case 3:
    case 5:
      return { text: message.text };
    case 4:
    case 6:
      return { payload: x(message.payload) };
    default:
      return {};
  }
}

function wireFields(r: Rec): Record<string, unknown> {
  const { bodyText: _b, textInput: _t, ...fields } = r.fields;
  return fields;
}

function serverOpenHttp(body: Uint8Array, secrets: Uint8Array[]) {
  const detected = detectBody(body);
  if (!detected.ok) return detected;
  const opened = openRecord(detected.wire, prefixed(secrets), "server", "http", true);
  return opened.ok ? { ...opened, encoding: detected.encoding, jsonKey: detected.jsonKey } : opened;
}

describe("the server's NP1 codec against np1.json", () => {
  it("opens every client record", () => {
    for (const r of v.records.filter((r: Rec) => r.direction === "client-to-server")) {
      const keys = r.ephPrefixed ? prefixed([h(r.serverSecret)]) : { key: h(r.key) };
      const opened = openRecord(h(r.wire), keys, "server", r.transport, r.ephPrefixed);
      expect(opened.ok, r.id).toBe(true);
      if (!opened.ok) continue;
      expect(opened.message.kind).toBe(r.kind);
      expect(fieldsOf(opened.message), r.id).toEqual(wireFields(r));
      expect(x(opened.key)).toBe(r.key);
    }
  });

  it("seals every server record byte for byte", () => {
    for (const r of v.records.filter((r: Rec) => r.direction === "server-to-client")) {
      const message: InnerMessage =
        r.kind === 2
          ? { kind: 2, status: r.fields.status, headers: r.fields.headers, body: h(r.fields.body) }
          : r.kind === 5
            ? { kind: 5, text: r.fields.text }
            : { kind: 6, payload: h(r.fields.payload) };
      const inner = buildInner(message, 2);
      expect(x(inner), r.id).toBe(r.inner);
      expect(x(sealRecord(h(r.key), h(r.nonce), inner)), r.id).toBe(r.wire);
    }
  });

  it("detects every client body and encodes every server body", () => {
    for (const b of v.bodies) {
      if (b.direction === "client-to-server") {
        const r = recordById.get(b.record);
        const opened = serverOpenHttp(h(b.body), [h(r.serverSecret)]);
        expect(opened, b.id).toMatchObject({ ok: true, encoding: b.encoding });
        if (b.jsonKey) expect(opened).toMatchObject({ jsonKey: b.jsonKey });
      } else {
        const body = encodeBody(new Uint8Array(h(b.wire)), b.encoding as BodyEncoding, b.jsonKey);
        expect(x(body), b.id).toBe(b.body);
      }
    }
  });

  it("opens the rotation vector with the stated key", () => {
    for (const t of v.rotation) {
      const secrets = t.serverSecrets.map(h);
      const opened = serverOpenHttp(h(t.body), secrets);
      expect(opened.ok).toBe(true);
      const ephPublic = detectBody(h(t.body));
      if (!opened.ok || !ephPublic.ok) continue;
      const expected = deriveSessionKey(secrets[t.opensWithIndex], ephPublic.wire.subarray(0, 32));
      expect(x(opened.key)).toBe(x(expected ?? new Uint8Array()));
    }
  });

  it("refuses every server-side negative vector with its stated error", () => {
    const protection = createNetworkProtection({
      privateKeys: [h(v.sessions[0].serverSecret)],
      routes: { include: ["/**"] },
    });
    let checked = 0;
    for (const n of v.negative.filter((n: { receiver: string }) => n.receiver === "server")) {
      let result: unknown;
      if (n.transport === "http") {
        result = serverOpenHttp(h(n.input), n.serverSecrets.map(h));
      } else {
        expect(n.serverSecrets).toEqual([v.sessions[0].serverSecret]);
        const frame = n.inputText ?? h(n.input);
        const state =
          n.frameIndex === 0 ? null : { key: toBase64url(h(n.key)), frameType: n.frameType };
        const opened = protection.openSocket(state, frame);
        result = opened.ok ? opened : { ok: false, error: opened.error };
      }
      expect(result, n.id).toEqual({ ok: false, error: n.error });
      checked++;
    }
    expect(checked).toBeGreaterThan(35);
  });

  it("refuses the client-side record vectors with their stated error", () => {
    for (const n of v.negative.filter(
      (n: { receiver: string; encoding?: string }) =>
        n.receiver === "client" && n.encoding !== "json",
    )) {
      const wire =
        n.inputText === undefined
          ? h(n.input)
          : (fromEitherBase64(n.inputText)?.bytes ?? new Uint8Array());
      const transport = n.transport;
      expect(openRecord(wire, { key: h(n.key) }, "client", transport, false), n.id).toEqual({
        ok: false,
        error: n.error,
      });
    }
  });

  it("pads to the server ladder: powers of two from 256, then 64 KiB steps", () => {
    const server = v.ladders.find((l: { id: string }) => l.id === "server");
    for (const { length, padded } of server.points)
      expect(ladderBucket(length, 2), `${length}`).toBe(padded);
    for (const l of v.ladders) {
      for (const { length, padded } of l.points) expect(ladderBucket(length, l.ratio)).toBe(padded);
    }
    expect(ladderBucket(0, 2)).toBe(256);
    expect(ladderBucket(256, 2)).toBe(256);
    expect(ladderBucket(257, 2)).toBe(512);
    expect(ladderBucket(32769, 2)).toBe(65536);
    expect(ladderBucket(65537, 2)).toBe(131072);
  });
});

describe("base64 forms", () => {
  it("round-trips every length in both alphabets, canonically", () => {
    for (let n = 0; n < 70; n++) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 97 + n * 13) & 0xff);
      expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
      expect(toBase64url(bytes)).toBe(Buffer.from(bytes).toString("base64url"));
      expect(fromBase64(toBase64(bytes))).toEqual(bytes);
      expect(fromBase64url(toBase64url(bytes))).toEqual(bytes);
    }
  });

  it("refuses non-canonical and mixed text", () => {
    expect(fromBase64("QQ==")).toEqual(new Uint8Array([0x41]));
    expect(fromBase64("QR==")).toBeNull();
    expect(fromBase64("QQ=")).toBeNull();
    expect(fromBase64url("QR")).toBeNull();
    expect(fromBase64url("Q")).toBeNull();
    expect(fromEitherBase64("ab+-")).toBeNull();
    expect(fromEitherBase64("abcd")?.encoding).toBe("base64url");
    expect(fromEitherBase64("ab+d")?.encoding).toBe("base64");
    expect(fromEitherBase64("ab-d")?.encoding).toBe("base64url");
  });

  it("detects text in both forms as base64url, and never reads Content-Type", () => {
    const both = new Uint8Array(Buffer.from(`${"QUJDRA".repeat(20)}QUJD`, "ascii"));
    expect(detectBody(both)).toMatchObject({ ok: true, encoding: "base64url" });
    const withPadding = new Uint8Array(Buffer.from("QUJDRA==", "ascii"));
    expect(detectBody(withPadding)).toMatchObject({ ok: true, encoding: "base64" });
    expect(detectBody(new Uint8Array([0x7b, 0x7d]))).toMatchObject({ ok: true, encoding: "raw" });
    expect(detectBody(new Uint8Array(Buffer.from('{"a":"QUJD","b":"x"}')))).toMatchObject({
      ok: true,
      encoding: "raw",
    });
  });
});
