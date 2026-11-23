import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  decodeBase64url,
  detectBody,
  type Encoding,
  openRequestBody,
  openResponseBody,
  openSocketFrame,
  openWire,
} from "../scripts/np1-reference.js";
import { renderFiles, VECTOR_FILES } from "../scripts/np1-vectors.js";
import {
  hsalsa20,
  publicKeyOf,
  secretboxOpen,
  secretboxSeal,
  sessionKeyOf,
  sharedSecret,
} from "./crypto.js";

const h = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "hex"));
const x = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

const committed = {
  vectors: readFileSync(VECTOR_FILES.vectors, "utf8"),
  schema: readFileSync(VECTOR_FILES.schema, "utf8"),
};
const v = JSON.parse(committed.vectors);
const schema = JSON.parse(committed.schema);

type Rec = (typeof v.records)[number];
const recordById = new Map<string, Rec>(v.records.map((r: Rec) => [r.id, r]));

function fieldsOf(r: Rec) {
  const { bodyText: _b, textInput: _t, ...wire } = r.fields;
  return wire;
}

describe("primitives as used", () => {
  it("pass the RFC 7748 X25519 vectors", () => {
    for (const t of v.primitives.x25519) {
      expect(x(sharedSecret(h(t.scalar), h(t.u)) ?? new Uint8Array())).toBe(t.output);
    }
  });

  it("pass the RFC 7748 iterated X25519 vectors", () => {
    let k: Uint8Array = new Uint8Array(32);
    k[0] = 9;
    let u: Uint8Array = k.slice();
    let done = 0;
    for (const t of [...v.primitives.x25519Iterated].sort((a, b) => a.iterations - b.iterations)) {
      for (; done < t.iterations; done++) {
        const next = sharedSecret(k, u);
        if (next === null) throw new Error("zero");
        u = k;
        k = next;
      }
      expect(x(k)).toBe(t.output);
    }
  });

  it("pass the RFC 7748 Diffie-Hellman vector", () => {
    for (const t of v.primitives.x25519Exchange) {
      expect(x(publicKeyOf(h(t.aliceSecret)))).toBe(t.alicePublic);
      expect(x(publicKeyOf(h(t.bobSecret)))).toBe(t.bobPublic);
      expect(x(sharedSecret(h(t.aliceSecret), h(t.bobPublic)) ?? new Uint8Array())).toBe(t.shared);
      expect(x(sharedSecret(h(t.bobSecret), h(t.alicePublic)) ?? new Uint8Array())).toBe(t.shared);
    }
  });

  it("pass the NaCl HSalsa20 vector", () => {
    for (const t of v.primitives.hsalsa20) {
      expect(x(hsalsa20(h(t.key), h(t.input)))).toBe(t.output);
      expect(x(sessionKeyOf(h(t.key)))).toBe(t.output);
    }
  });

  it("pass the NaCl secretbox vector both ways", () => {
    for (const t of v.primitives.secretbox) {
      expect(x(secretboxSeal(h(t.key), h(t.nonce), h(t.plaintext)))).toBe(t.box);
      expect(x(secretboxOpen(h(t.key), h(t.nonce), h(t.box)) ?? new Uint8Array())).toBe(
        t.plaintext,
      );
    }
  });

  it("pass the NaCl box vector as beforenm then secretbox", () => {
    for (const t of v.primitives.box) {
      const shared = sharedSecret(h(t.senderSecret), h(t.recipientPublic));
      if (shared === null) throw new Error("zero");
      const key = sessionKeyOf(shared);
      expect(x(key)).toBe(t.sessionKey);
      expect(x(secretboxSeal(key, h(t.nonce), h(t.plaintext)))).toBe(t.box);
    }
  });

  it("refuse a forged tag and a short box", () => {
    const t = v.primitives.secretbox[0];
    const forged = h(t.box);
    forged[0] ^= 1;
    expect(secretboxOpen(h(t.key), h(t.nonce), forged)).toBeNull();
    expect(secretboxOpen(h(t.key), h(t.nonce), new Uint8Array(15))).toBeNull();
  });

  it("report low-order public keys as no shared secret", () => {
    const secret = h(v.primitives.x25519Exchange[0].aliceSecret);
    expect(sharedSecret(secret, new Uint8Array(32))).toBeNull();
  });
});

describe("np1.json", () => {
  it("regenerates byte for byte", () => {
    const fresh = renderFiles();
    expect(fresh.vectors).toBe(committed.vectors);
    expect(fresh.schema).toBe(committed.schema);
  });

  it("validates against np1.schema.json", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
    const validate = ajv.compile(schema);
    const valid = validate(v);
    expect(validate.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
  });

  it("covers every kind, encoding, frame type, ladder and error", () => {
    expect(new Set(v.records.map((r: Rec) => r.kind))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7]));
    expect(new Set(v.bodies.map((b: { encoding: string }) => b.encoding))).toEqual(
      new Set(["raw", "base64", "base64url", "json"]),
    );
    expect(new Set(v.sockets.map((s: { frameType: string }) => s.frameType))).toEqual(
      new Set(["binary", "text"]),
    );
    expect(new Set(v.sessions.map((s: { topBit: number }) => s.topBit))).toEqual(new Set([0, 1]));
    expect(new Set(v.records.map((r: Rec) => r.ladder))).toEqual(
      new Set(["client-1.5", "client-2", "server", "none"]),
    );
    expect(new Set(v.negative.map((n: { error: string }) => n.error))).toEqual(
      new Set(schema.properties.negative.items.properties.error.enum),
    );
  });

  it("derives every session key on both sides", () => {
    for (const s of v.sessions) {
      expect(x(publicKeyOf(h(s.serverSecret)))).toBe(s.serverPublic);
      expect(x(publicKeyOf(h(s.ephSecret)))).toBe(s.ephPublicCanonical);
      expect(h(s.ephPublic)[31] >> 7).toBe(s.topBit);
      expect(h(s.ephPublic).subarray(0, 31)).toEqual(h(s.ephPublicCanonical).subarray(0, 31));
      expect(x(sharedSecret(h(s.ephSecret), h(s.serverPublic)) ?? new Uint8Array())).toBe(s.shared);
      expect(x(sharedSecret(h(s.serverSecret), h(s.ephPublic)) ?? new Uint8Array())).toBe(s.shared);
      expect(x(sharedSecret(h(s.serverSecret), h(s.ephPublicCanonical)) ?? new Uint8Array())).toBe(
        s.shared,
      );
      expect(x(sessionKeyOf(h(s.shared)))).toBe(s.key);
    }
  });

  it("keeps every record's intermediate values consistent", () => {
    const ladders = new Map(v.ladders.map((l: { id: string }) => [l.id, l]));
    for (const r of v.records) {
      const session = v.sessions.find((s: { id: string }) => s.id === r.session);
      for (const k of ["serverSecret", "serverPublic", "ephSecret", "ephPublic", "shared", "key"]) {
        expect(r[k], `${r.id} ${k}`).toBe(session[k]);
      }
      expect(r.innerLayout.map((s: { hex: string }) => s.hex).join("")).toBe(r.inner);
      expect(r.inner.length / 2).toBe(r.paddedLength);
      const padding = r.innerLayout.find((s: { field: string }) => s.field === "padding");
      expect(r.paddedLength - r.unpaddedLength).toBe(padding ? padding.hex.length / 2 : 0);
      if (padding) expect(new Set(padding.hex.match(/../g))).toEqual(new Set([r.paddingByte]));
      if (r.ladder !== "none") {
        const point = (ladders.get(r.ladder) as { geometricBuckets: number[] }).geometricBuckets;
        const target = point.find((b) => b >= r.unpaddedLength) ?? 0;
        expect(r.paddedLength, r.id).toBe(target);
      } else {
        expect(r.paddedLength).toBe(r.unpaddedLength);
      }
      expect(x(secretboxSeal(h(r.key), h(r.nonce), h(r.inner)))).toBe(r.box);
      expect(r.tag + r.ciphertext).toBe(r.box);
      expect(r.ciphertext.length).toBe(r.inner.length);
      expect(r.record).toBe(r.nonce + r.box);
      expect(r.wire).toBe(r.ephPrefixed ? r.ephPublic + r.record : r.record);
    }
  });

  it("has ladder points that follow the stated rule", () => {
    for (const l of v.ladders) {
      for (const { length, padded } of l.points) {
        const bucket = l.geometricBuckets.find((b: number) => b >= length);
        expect(padded, `${l.id} ${length}`).toBe(bucket ?? Math.ceil(length / 65536) * 65536);
      }
    }
  });

  it("opens every record with the reference receiver", () => {
    for (const r of v.records) {
      const first = r.ephPrefixed;
      const receiver = r.direction === "client-to-server" ? "server" : "client";
      const keys = first ? { serverSecrets: [h(r.serverSecret)] } : { key: h(r.key) };
      const opened = openWire(h(r.wire), keys, receiver, r.transport, first);
      expect(opened, r.id).toMatchObject({ ok: true, kind: r.kind, fields: fieldsOf(r) });
    }
  });

  it("decodes every outer body to its record's wire", () => {
    for (const b of v.bodies) {
      const r = recordById.get(b.record);
      expect(b.wire).toBe(r?.wire);
      if (b.bodyText !== undefined) expect(x(Buffer.from(b.bodyText, "utf8"))).toBe(b.body);
      if (b.direction === "client-to-server") {
        const detected = detectBody(h(b.body));
        expect(detected).toMatchObject({ encoding: b.encoding, wire: h(b.wire) });
        if (b.jsonKey) expect(detected).toMatchObject({ jsonKey: b.jsonKey });
        const opened = openRequestBody(h(b.body), [h(r.serverSecret)]);
        expect(opened, b.id).toMatchObject({ ok: true, fields: fieldsOf(r) });
      } else {
        const opened = openResponseBody(h(b.body), h(r.key), b.encoding as Encoding);
        expect(opened, b.id).toMatchObject({ ok: true, fields: fieldsOf(r) });
      }
    }
  });

  it("plays every socket frame in order", () => {
    for (const s of v.sockets) {
      const session = v.sessions.find((x: { id: string }) => x.id === s.session);
      let clientFrames = 0;
      for (const f of s.frames) {
        const r = recordById.get(f.record);
        expect(f.wire).toBe(r?.wire);
        if (s.frameType === "text") {
          expect(x(Buffer.from(f.frameText, "utf8"))).toBe(f.frame);
          expect(x(decodeBase64url(f.frameText)?.bytes ?? new Uint8Array())).toBe(f.wire);
        } else {
          expect(f.frame).toBe(f.wire);
        }
        const frame = s.frameType === "text" ? f.frameText : h(f.frame);
        const toServer = f.direction === "client-to-server";
        const first = toServer && clientFrames === 0;
        expect(r?.ephPrefixed).toBe(first);
        const keys = first ? { serverSecrets: [h(session.serverSecret)] } : { key: h(session.key) };
        const opened = openSocketFrame(
          frame,
          s.frameType,
          toServer ? "server" : "client",
          toServer ? clientFrames : 1,
          keys,
        );
        expect(opened, f.record).toMatchObject({ ok: true, kind: f.kind, fields: fieldsOf(r) });
        if (toServer) clientFrames++;
      }
    }
  });

  it("opens the rotation vector with the stated key", () => {
    for (const t of v.rotation) {
      const opened = openRequestBody(h(t.body), t.serverSecrets.map(h));
      expect(opened).toMatchObject({ ok: true, keyIndex: t.opensWithIndex });
      expect(opened).toMatchObject({ fields: fieldsOf(recordById.get(t.record)) });
    }
  });

  it("refuses every negative vector with its stated error", () => {
    for (const n of v.negative) {
      const input = n.inputText ?? h(n.input);
      if (n.inputText !== undefined) expect(x(Buffer.from(n.inputText, "utf8"))).toBe(n.input);
      let result: unknown;
      if (n.transport === "http" && n.receiver === "server") {
        result = openRequestBody(h(n.input), n.serverSecrets.map(h));
      } else if (n.transport === "http") {
        result = openResponseBody(h(n.input), h(n.key), n.encoding);
      } else {
        const keys =
          n.receiver === "server" && n.frameIndex === 0
            ? { serverSecrets: n.serverSecrets.map(h) }
            : { key: h(n.key) };
        result = openSocketFrame(input, n.frameType, n.receiver, n.frameIndex, keys);
      }
      expect(result, n.id).toEqual({ ok: false, error: n.error });
    }
  });

  it("states intermediate values that hold", () => {
    for (const n of v.negative) {
      const i = n.intermediate;
      if (i.wire !== undefined && n.inputText === undefined) expect(i.wire, n.id).toBe(n.input);
      if (i.shared !== undefined && i.key !== undefined) {
        expect(x(sessionKeyOf(h(i.shared))), n.id).toBe(i.key);
      }
      if (i.shared !== undefined && i.ephPublic !== undefined) {
        const shared = sharedSecret(h(n.serverSecrets[0]), h(i.ephPublic));
        expect(x(shared ?? new Uint8Array(32)), n.id).toBe(i.shared);
      }
      if (i.inner !== undefined && i.key !== undefined && i.box !== undefined) {
        const reopened = secretboxOpen(h(i.key), h(i.nonce), h(i.box));
        expect(x(reopened ?? new Uint8Array()), n.id).toBe(i.inner);
      }
      if (i.inner !== undefined && i.key === undefined && n.key !== undefined) {
        const reopened = secretboxOpen(h(n.key), h(i.nonce), h(i.box));
        expect(x(reopened ?? new Uint8Array()), n.id).toBe(i.inner);
      }
    }
  });
});
