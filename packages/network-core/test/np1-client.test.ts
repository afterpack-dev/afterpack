import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeOuter, type Encoding, encodeOuter, Np1TestClient } from "./np1-client.js";

const v = JSON.parse(readFileSync(new URL("../vectors/np1.json", import.meta.url), "utf8"));
const h = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "hex"));
const x = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

type Rec = (typeof v.records)[number];
const ladders: Record<string, number | null> = {
  "client-1.5": 1.5,
  "client-2": 2,
  server: 2,
  none: null,
};

function clientFor(r: Rec): Np1TestClient {
  const session = v.sessions.find((s: { id: string }) => s.id === r.session);
  return new Np1TestClient({
    serverPublic: h(session.serverPublic),
    ephSecret: h(session.ephSecret),
    topBit: session.topBit,
    ratio: ladders[r.ladder],
    nonce: () => h(r.nonce),
    padByte: Number.parseInt(r.paddingByte, 16),
  });
}

describe("the independent test client", () => {
  it("derives every vector session key", () => {
    for (const s of v.sessions) {
      const client = new Np1TestClient({
        serverPublic: h(s.serverPublic),
        ephSecret: h(s.ephSecret),
        topBit: s.topBit,
      });
      expect(x(client.key)).toBe(s.key);
      expect(x(client.ephPublic)).toBe(s.ephPublic);
    }
  });

  it("seals every client record of the vectors byte for byte", () => {
    const clientRecords = v.records.filter((r: Rec) => r.direction === "client-to-server");
    expect(new Set(clientRecords.map((r: Rec) => r.kind))).toEqual(new Set([1, 3, 4, 7]));
    for (const r of clientRecords) {
      const client = clientFor(r);
      let inner: Uint8Array;
      if (r.kind === 1) {
        inner = client.requestInner(
          r.fields.method,
          r.fields.target,
          r.fields.headers,
          h(r.fields.body),
        );
      } else if (r.kind === 3) {
        inner = client.socketInner(r.fields.textInput ?? r.fields.text);
      } else if (r.kind === 4) {
        inner = client.socketInner(h(r.fields.payload));
      } else {
        inner = client.socketInner(null);
      }
      expect(x(inner), r.id).toBe(r.inner);
      const record = client.record(inner);
      expect(x(r.ephPrefixed ? client.prefixed(record) : record), r.id).toBe(r.wire);
    }
  });

  it("opens every server record of the vectors", () => {
    for (const r of v.records.filter((r: Rec) => r.direction === "server-to-client")) {
      const client = clientFor(r);
      if (r.kind === 2) {
        const opened = client.openResponse(h(r.wire), "raw");
        expect(opened.status).toBe(r.fields.status);
        expect(opened.headers).toEqual(r.fields.headers);
        expect(x(opened.body)).toBe(r.fields.body);
      } else {
        const opened = client.openSocketFrame(h(r.wire));
        expect(typeof opened === "string" ? opened : x(opened)).toBe(
          r.fields.text ?? r.fields.payload,
        );
      }
    }
  });

  it("encodes and decodes every outer body of the vectors", () => {
    for (const b of v.bodies) {
      expect(x(decodeOuter(h(b.body), b.encoding as Encoding)), b.id).toBe(b.wire);
      expect(x(encodeOuter(h(b.wire), b.encoding as Encoding, b.jsonKey)), b.id).toBe(b.body);
    }
  });
});
