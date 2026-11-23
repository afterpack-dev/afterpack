import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { publicKeyOf, secretboxSeal, sessionKeyOf, sharedSecret } from "../src/crypto.js";
import { np1Schema } from "./np1-schema.js";

type Encoding = "raw" | "base64" | "base64url" | "json";
type LadderId = "client-1.5" | "client-2" | "server" | "none";
type Headers = [string, string][];

type Fields = {
  method?: string;
  target?: string;
  status?: number;
  headers?: Headers;
  body?: Uint8Array;
  text?: string;
  payload?: Uint8Array;
};

type Segment = { field: string; hex: string };

const VECTORS_URL = new URL("../vectors/np1.json", import.meta.url);
const SCHEMA_URL = new URL("../vectors/np1.schema.json", import.meta.url);

const KINDS = [
  {
    kind: 1,
    name: "http-request",
    direction: "client-to-server",
    transport: "http",
    fields: ["method", "target", "headers", "body"],
  },
  {
    kind: 2,
    name: "http-response",
    direction: "server-to-client",
    transport: "http",
    fields: ["status", "headers", "body"],
  },
  {
    kind: 3,
    name: "socket-client-text",
    direction: "client-to-server",
    transport: "socket",
    fields: ["text"],
  },
  {
    kind: 4,
    name: "socket-client-binary",
    direction: "client-to-server",
    transport: "socket",
    fields: ["payload"],
  },
  {
    kind: 5,
    name: "socket-server-text",
    direction: "server-to-client",
    transport: "socket",
    fields: ["text"],
  },
  {
    kind: 6,
    name: "socket-server-binary",
    direction: "server-to-client",
    transport: "socket",
    fields: ["payload"],
  },
  {
    kind: 7,
    name: "socket-handshake",
    direction: "client-to-server",
    transport: "socket",
    fields: [],
  },
] as const;

const CONTENT_TYPES: Record<Encoding, string> = {
  raw: "application/octet-stream",
  base64: "text/plain;charset=UTF-8",
  base64url: "text/plain;charset=UTF-8",
  json: "application/json",
};

const JSON_KEY = "q7";

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const fromHex = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "hex"));
const utf8 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "utf8"));

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function det(label: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let counter = 0, filled = 0; filled < length; counter++) {
    const block = createHash("sha256").update(`np1-vectors/${label}/${counter}`).digest();
    out.set(block.subarray(0, Math.min(32, length - filled)), filled);
    filled += 32;
  }
  return out;
}

function leb128(value: number): Uint8Array {
  const out: number[] = [];
  let rest = value;
  do {
    const low = rest % 128;
    rest = Math.floor(rest / 128);
    out.push(rest > 0 ? low | 0x80 : low);
  } while (rest > 0);
  return new Uint8Array(out);
}

function ladderBuckets(ratio: number): number[] {
  const out: number[] = [];
  for (let i = 0; ; i++) {
    const bucket = Math.ceil(256 * ratio ** i);
    if (bucket >= 65536) return out;
    out.push(bucket);
  }
}

const LADDER_RATIOS: Record<Exclude<LadderId, "none">, number> = {
  "client-1.5": 1.5,
  "client-2": 2,
  server: 2,
};

function padTarget(length: number, ladder: LadderId): number {
  if (ladder === "none") return length;
  for (const bucket of ladderBuckets(LADDER_RATIOS[ladder])) if (length <= bucket) return bucket;
  return Math.ceil(length / 65536) * 65536;
}

class InnerWriter {
  readonly segments: Segment[] = [];

  push(field: string, bytes: Uint8Array): void {
    this.segments.push({ field, hex: hex(bytes) });
  }

  uint(field: string, value: number): void {
    this.push(field, leb128(value));
  }

  bytes(field: string, value: Uint8Array): void {
    this.uint(`${field}.length`, value.length);
    this.push(field, value);
  }

  string(field: string, value: string): void {
    this.bytes(field, utf8(value));
  }

  headers(list: Headers): void {
    this.uint("headers.count", list.length);
    list.forEach(([name, value], i) => {
      this.string(`headers[${i}].name`, name);
      this.string(`headers[${i}].value`, value);
    });
  }

  get length(): number {
    return this.segments.reduce((n, s) => n + s.hex.length / 2, 0);
  }

  bytesOut(): Uint8Array {
    return fromHex(this.segments.map((s) => s.hex).join(""));
  }
}

function writeFields(writer: InnerWriter, kind: number, fields: Fields): void {
  switch (kind) {
    case 1:
      writer.string("method", fields.method ?? "");
      writer.string("target", fields.target ?? "");
      writer.headers(fields.headers ?? []);
      writer.bytes("body", fields.body ?? new Uint8Array());
      return;
    case 2:
      writer.uint("status", fields.status ?? 0);
      writer.headers(fields.headers ?? []);
      writer.bytes("body", fields.body ?? new Uint8Array());
      return;
    case 3:
    case 5:
      writer.string("text", fields.text ?? "");
      return;
    case 4:
    case 6:
      writer.bytes("payload", fields.payload ?? new Uint8Array());
      return;
  }
}

type Session = {
  id: string;
  description: string;
  serverSecret: Uint8Array;
  serverPublic: Uint8Array;
  ephSecret: Uint8Array;
  ephPublicCanonical: Uint8Array;
  topBit: 0 | 1;
  ephPublic: Uint8Array;
  shared: Uint8Array;
  key: Uint8Array;
};

const SERVER_SECRET = det("server/primary", 32);
const RETIRED_SECRET = det("server/retired", 32);

function makeSession(id: string, description: string, topBit: 0 | 1): Session {
  const ephSecret = det(`session/${id}/eph-secret`, 32);
  const ephPublicCanonical = publicKeyOf(ephSecret);
  const ephPublic = ephPublicCanonical.slice();
  if (topBit === 1) ephPublic[31] |= 0x80;
  const shared = sharedSecret(ephSecret, publicKeyOf(SERVER_SECRET));
  if (shared === null) throw new Error(`zero shared secret for ${id}`);
  return {
    id,
    description,
    serverSecret: SERVER_SECRET,
    serverPublic: publicKeyOf(SERVER_SECRET),
    ephSecret,
    ephPublicCanonical,
    topBit,
    ephPublic,
    shared,
    key: sessionKeyOf(shared),
  };
}

const SESSIONS = [
  makeSession("http-a", "HTTP session; the sent ephPublic has its top bit clear.", 0),
  makeSession("http-b", "HTTP session; the sent ephPublic has its top bit set.", 1),
  makeSession("socket-binary", "Socket with binary frames; top bit set.", 1),
  makeSession("socket-text", "Socket with text frames; top bit clear.", 0),
];

const sessionById = (id: string): Session => {
  const session = SESSIONS.find((s) => s.id === id);
  if (session === undefined) throw new Error(`unknown session ${id}`);
  return session;
};

type RecordSpec = {
  id: string;
  description: string;
  session: string;
  kind: number;
  fields: Fields;
  textInput?: string;
  ladder: LadderId;
  first?: boolean;
  paddingByte?: number;
};

type BuiltRecord = {
  spec: RecordSpec;
  session: Session;
  inner: Uint8Array;
  nonce: Uint8Array;
  box: Uint8Array;
  record: Uint8Array;
  wire: Uint8Array;
  json: Record<string, unknown>;
};

function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function logicalFields(spec: RecordSpec): Record<string, unknown> {
  const f = spec.fields;
  const out: Record<string, unknown> = {};
  if (f.method !== undefined) out.method = f.method;
  if (f.target !== undefined) out.target = f.target;
  if (f.status !== undefined) out.status = f.status;
  if (f.headers !== undefined) out.headers = f.headers;
  if (f.body !== undefined) {
    out.body = hex(f.body);
    if (f.body.length > 0 && isUtf8(f.body)) out.bodyText = Buffer.from(f.body).toString("utf8");
  }
  if (f.text !== undefined) out.text = f.text;
  if (spec.textInput !== undefined) out.textInput = spec.textInput;
  if (f.payload !== undefined) out.payload = hex(f.payload);
  return out;
}

function buildInner(
  kind: number,
  fields: Fields,
  ladder: LadderId,
  paddingByte = 0,
  version = 1,
): { writer: InnerWriter; unpadded: number } {
  const writer = new InnerWriter();
  writer.push("version", new Uint8Array([version]));
  writer.push("kind", new Uint8Array([kind]));
  writeFields(writer, kind, fields);
  const unpadded = writer.length;
  const target = padTarget(unpadded, ladder);
  if (target > unpadded)
    writer.push("padding", new Uint8Array(target - unpadded).fill(paddingByte));
  return { writer, unpadded };
}

function seal(
  session: Session,
  nonceLabel: string,
  inner: Uint8Array,
  prefixed: boolean,
): { nonce: Uint8Array; box: Uint8Array; record: Uint8Array; wire: Uint8Array } {
  const nonce = det(`nonce/${nonceLabel}`, 24);
  const box = secretboxSeal(session.key, nonce, inner);
  const record = concat(nonce, box);
  return { nonce, box, record, wire: prefixed ? concat(session.ephPublic, record) : record };
}

function buildRecord(spec: RecordSpec): BuiltRecord {
  const session = sessionById(spec.session);
  const meta = KINDS[spec.kind - 1];
  const prefixed =
    meta.direction === "client-to-server" && (meta.transport === "http" || !!spec.first);
  const { writer, unpadded } = buildInner(spec.kind, spec.fields, spec.ladder, spec.paddingByte);
  const inner = writer.bytesOut();
  const sealed = seal(session, `record/${spec.id}`, inner, prefixed);
  const json = {
    id: spec.id,
    description: spec.description,
    session: session.id,
    kind: spec.kind,
    kindName: meta.name,
    direction: meta.direction,
    transport: meta.transport,
    ephPrefixed: prefixed,
    fields: logicalFields(spec),
    ladder: spec.ladder,
    paddingByte: hex(new Uint8Array([spec.paddingByte ?? 0])),
    unpaddedLength: unpadded,
    paddedLength: inner.length,
    innerLayout: writer.segments,
    inner: hex(inner),
    serverSecret: hex(session.serverSecret),
    serverPublic: hex(session.serverPublic),
    ephSecret: hex(session.ephSecret),
    ephPublic: hex(session.ephPublic),
    shared: hex(session.shared),
    key: hex(session.key),
    nonce: hex(sealed.nonce),
    box: hex(sealed.box),
    tag: hex(sealed.box.subarray(0, 16)),
    ciphertext: hex(sealed.box.subarray(16)),
    record: hex(sealed.record),
    wire: hex(sealed.wire),
  };
  return { spec, session, inner, ...sealed, json };
}

const LONG_EVENT = utf8(
  JSON.stringify({
    events: Array.from({ length: 6 }, (_, i) => ({
      name: `screen_view_${i}`,
      at: 1767225600000 + i * 1000,
      props: { screen: "lobby", seat: i },
    })),
  }),
);

const RECORD_SPECS: RecordSpec[] = [
  {
    id: "http-get",
    description: "GET with a query string and one header, empty body, client ladder 1.5.",
    session: "http-a",
    kind: 1,
    fields: {
      method: "GET",
      target: "/api/items?limit=2&q=caf%C3%A9",
      headers: [["accept", "application/json"]],
      body: new Uint8Array(),
    },
    ladder: "client-1.5",
  },
  {
    id: "http-post",
    description:
      "POST with a JSON body; headers include a repeated name and a value with U+00E9, which travels as UTF-8 (c3 a9). Client ladder 2.",
    session: "http-b",
    kind: 1,
    fields: {
      method: "POST",
      target: "/api/events",
      headers: [
        ["content-type", "application/json"],
        ["x-sync", "7"],
        ["x-tag", "a"],
        ["x-tag", "b"],
        ["x-note", "café"],
      ],
      body: utf8('{"event":"seat","table":12}'),
    },
    ladder: "client-2",
  },
  {
    id: "http-post-long",
    description:
      "POST whose unpadded inner is past the first bucket, so the 1.5 ladder pads it to 576.",
    session: "http-a",
    kind: 1,
    fields: {
      method: "POST",
      target: "/api/batch",
      headers: [["content-type", "application/json"]],
      body: LONG_EVENT,
    },
    ladder: "client-1.5",
  },
  {
    id: "http-exact-bucket",
    description: "DELETE whose unpadded inner is exactly 256 bytes, so no padding is added.",
    session: "http-a",
    kind: 1,
    fields: {
      method: "DELETE",
      target: "/api/items/42",
      headers: [],
      body: new Uint8Array(256 - 2 - 7 - 14 - 1 - 2).fill(0x78),
    },
    ladder: "client-2",
  },
  {
    id: "http-nonzero-padding",
    description:
      "PUT padded with 0xaa bytes instead of zeros. Receivers ignore padding content, so it opens like any other record.",
    session: "http-b",
    kind: 1,
    fields: { method: "PUT", target: "/api/me", headers: [], body: utf8("ok") },
    ladder: "client-2",
    paddingByte: 0xaa,
  },
  {
    id: "http-unpadded",
    description:
      "PATCH with no padding at all. Receivers never check the padded length, so it opens.",
    session: "http-b",
    kind: 1,
    fields: { method: "PATCH", target: "/", headers: [], body: new Uint8Array() },
    ladder: "none",
  },
  {
    id: "http-200",
    description: "200 response with JSON, on the server ladder.",
    session: "http-a",
    kind: 2,
    fields: {
      status: 200,
      headers: [
        ["content-type", "application/json"],
        ["x-request-id", "r-1"],
      ],
      body: utf8('{"items":[1,2]}'),
    },
    ladder: "server",
  },
  {
    id: "http-302",
    description: "302 redirect, returned untouched for the client to apply the redirect mode.",
    session: "http-b",
    kind: 2,
    fields: { status: 302, headers: [["location", "/api/items/2"]], body: new Uint8Array() },
    ladder: "server",
  },
  {
    id: "http-404",
    description: "404 with a text body.",
    session: "http-a",
    kind: 2,
    fields: {
      status: 404,
      headers: [["content-type", "text/plain;charset=UTF-8"]],
      body: utf8("not found"),
    },
    ladder: "server",
  },
  {
    id: "socket-binary-handshake",
    description: "First client frame: kind 7 opens the session with nothing to send.",
    session: "socket-binary",
    kind: 7,
    fields: {},
    ladder: "client-2",
    first: true,
  },
  {
    id: "socket-binary-server-text",
    description: "Server text message.",
    session: "socket-binary",
    kind: 5,
    fields: { text: "welcome \u{1f30d}" },
    ladder: "server",
  },
  {
    id: "socket-binary-client-text",
    description: "Later client text message, non-ASCII, no prefix.",
    session: "socket-binary",
    kind: 3,
    fields: { text: "move e2e4 — é" },
    ladder: "client-2",
  },
  {
    id: "socket-binary-client-binary",
    description: "Client binary message with every byte value.",
    session: "socket-binary",
    kind: 4,
    fields: { payload: new Uint8Array(256).map((_, i) => i) },
    ladder: "client-2",
  },
  {
    id: "socket-binary-server-binary",
    description: "Server binary message.",
    session: "socket-binary",
    kind: 6,
    fields: { payload: fromHex("00ff10ef") },
    ladder: "server",
  },
  {
    id: "socket-text-first",
    description:
      "First client frame carrying the first message itself (kind 3). The app's string holds a lone surrogate, which is written as U+FFFD.",
    session: "socket-text",
    kind: 3,
    fields: { text: "hi �!" },
    textInput: "hi \ud800!",
    ladder: "client-1.5",
    first: true,
  },
  {
    id: "socket-text-server-binary",
    description: "Server binary message on a text-frame socket.",
    session: "socket-text",
    kind: 6,
    fields: { payload: fromHex("0102030405") },
    ladder: "server",
  },
  {
    id: "socket-text-client-binary",
    description: "Later client binary message on a text-frame socket.",
    session: "socket-text",
    kind: 4,
    fields: { payload: new Uint8Array() },
    ladder: "client-1.5",
  },
];

function buildPrimitives() {
  return {
    x25519: [
      {
        source: "RFC 7748 section 5.2",
        scalar: "a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4",
        u: "e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c",
        output: "c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552",
      },
      {
        source: "RFC 7748 section 5.2; the input u has its top bit set",
        scalar: "4b66e9d4d1b4673c5ad22691957d6af5c11b6421e0ea01d42ca4169e7918ba0d",
        u: "e5210f12786811d3f4b7959d0538ae2c31dbe7106fc03c3efc4cd549c715a493",
        output: "95cbde9476e8907d7aade45cb4b873f88b595a68799fa152e6f8f7647aac7957",
      },
    ],
    x25519Iterated: [
      {
        source: "RFC 7748 section 5.2: k = u = 9, then (k, u) = (X25519(k, u), k)",
        iterations: 1,
        output: "422c8e7a6227d7bca1350b3e2bb7279f7897b87bb6854b783c60e80311ae3079",
      },
      {
        source: "RFC 7748 section 5.2: k = u = 9, then (k, u) = (X25519(k, u), k)",
        iterations: 1000,
        output: "684cf59ba83309552800ef566f2f4d3c1c3887c49360e3875f2eb94d99532c51",
      },
    ],
    x25519Exchange: [
      {
        source: "RFC 7748 section 6.1",
        aliceSecret: "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a",
        alicePublic: "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a",
        bobSecret: "5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb",
        bobPublic: "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f",
        shared: "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742",
      },
    ],
    hsalsa20: [
      {
        source:
          "NaCl and libsodium core1 test: crypto_box_beforenm of the RFC 7748 section 6.1 pair",
        key: "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742",
        input: "00000000000000000000000000000000",
        output: "1b27556473e985d462cd51197a9a46c76009549eac6474f206c4ee0844f68389",
      },
    ],
    secretbox: [
      {
        source: "NaCl and libsodium secretbox test, tag first as in secretbox_easy",
        key: "1b27556473e985d462cd51197a9a46c76009549eac6474f206c4ee0844f68389",
        nonce: NACL_NONCE,
        plaintext: NACL_MESSAGE,
        box: NACL_BOX,
      },
    ],
    box: [
      {
        source: "NaCl and libsodium box test, tag first as in box_easy",
        senderSecret: "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a",
        recipientPublic: "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f",
        nonce: NACL_NONCE,
        plaintext: NACL_MESSAGE,
        sessionKey: "1b27556473e985d462cd51197a9a46c76009549eac6474f206c4ee0844f68389",
        box: NACL_BOX,
      },
    ],
  };
}

const NACL_NONCE = "69696ee955b62b73cd62bda875fc73d68219e0036b7a0b37";
const NACL_MESSAGE =
  "be075fc53c81f2d5cf141316ebeb0c7b5228c52a4c62cbd44b66849b64244ffce5ecbaaf33bd751a1ac728d45e6c61296cdc3c01233561f41db66cce314adb310e3be8250c46f06dceea3a7fa1348057e2f6556ad6b1318a024a838f21af1fde048977eb48f59ffd4924ca1c60902e52f0a089bc76897040e082f937763848645e0705";
const NACL_BOX =
  "f3ffc7703f9400e52a7dfb4b3d3305d98e993b9f48681273c29650ba32fc76ce48332ea7164d96a4476fb8c531a1186ac0dfc17c98dce87b4da7f011ec48c97271d2c20f9b928fe2270d6fb863d51738b48eeee314a7cc8ab932164548e526ae90224368517acfeabd6bb3732bc0e9da99832b61ca01b6de56244a9e88d5f9b37973f622a43d14a6599b1f654cb45a74e355a5";

const LADDER_POINTS = [
  1, 2, 255, 256, 257, 384, 385, 512, 513, 9841, 9842, 32768, 32769, 49823, 49824, 65535, 65536,
  65537, 131072, 131073,
];

function buildLadders() {
  return (["client-1.5", "client-2", "server"] as const).map((id) => ({
    id,
    ratio: LADDER_RATIOS[id],
    geometricBuckets: ladderBuckets(LADDER_RATIOS[id]),
    stepBytes: 65536,
    points: LADDER_POINTS.map((length) => ({ length, padded: padTarget(length, id) })),
  }));
}

function encodeBody(wire: Uint8Array, encoding: Encoding): { body: Uint8Array; text?: string } {
  switch (encoding) {
    case "raw":
      return { body: wire };
    case "base64":
    case "base64url": {
      const text = Buffer.from(wire).toString(encoding);
      return { body: utf8(text), text };
    }
    case "json": {
      const text = JSON.stringify({ [JSON_KEY]: Buffer.from(wire).toString("base64url") });
      return { body: utf8(text), text };
    }
  }
}

const ENCODINGS: Encoding[] = ["raw", "base64url", "base64", "json"];

function buildBodies(records: Map<string, BuiltRecord>) {
  const out: Record<string, unknown>[] = [];
  for (const recordId of ["http-get", "http-200", "http-302"]) {
    const built = records.get(recordId);
    if (built === undefined) throw new Error(recordId);
    const direction = KINDS[built.spec.kind - 1].direction;
    for (const encoding of ENCODINGS) {
      const { body, text } = encodeBody(built.wire, encoding);
      out.push({
        id: `${recordId}-${encoding}`,
        record: recordId,
        direction,
        encoding,
        contentType: CONTENT_TYPES[encoding],
        ...(encoding === "json" ? { jsonKey: JSON_KEY } : {}),
        wire: hex(built.wire),
        body: hex(body),
        ...(text !== undefined ? { bodyText: text } : {}),
      });
    }
  }
  return out;
}

function buildSockets(records: Map<string, BuiltRecord>) {
  const sockets = [
    {
      id: "socket-binary",
      description:
        "Binary frames. The client opens with a kind 7 handshake, the server's buffered message follows, then traffic both ways.",
      session: "socket-binary",
      frameType: "binary" as const,
      frames: [
        "socket-binary-handshake",
        "socket-binary-server-text",
        "socket-binary-client-text",
        "socket-binary-client-binary",
        "socket-binary-server-binary",
      ],
    },
    {
      id: "socket-text",
      description:
        "Text frames carrying base64url. The first client frame carries the app's first message instead of a handshake.",
      session: "socket-text",
      frameType: "text" as const,
      frames: ["socket-text-first", "socket-text-server-binary", "socket-text-client-binary"],
    },
  ];
  return sockets.map((socket) => ({
    id: socket.id,
    description: socket.description,
    session: socket.session,
    frameType: socket.frameType,
    frames: socket.frames.map((recordId, index) => {
      const built = records.get(recordId);
      if (built === undefined) throw new Error(recordId);
      const text =
        socket.frameType === "text" ? Buffer.from(built.wire).toString("base64url") : undefined;
      return {
        index,
        record: recordId,
        direction: KINDS[built.spec.kind - 1].direction,
        kind: built.spec.kind,
        wire: hex(built.wire),
        frame: text === undefined ? hex(built.wire) : hex(utf8(text)),
        ...(text !== undefined ? { frameText: text } : {}),
      };
    }),
  }));
}

function buildRotation(records: Map<string, BuiltRecord>) {
  const built = records.get("http-post");
  if (built === undefined) throw new Error("http-post");
  return [
    {
      id: "rotation-second-key",
      description:
        "The server holds a retired key first and the current key second; the first fails to open, the second opens.",
      record: "http-post",
      serverSecrets: [hex(RETIRED_SECRET), hex(SERVER_SECRET)],
      body: hex(built.wire),
      opensWithIndex: 1,
    },
  ];
}

type Negative = Record<string, unknown>;

function flip(bytes: Uint8Array, index: number): Uint8Array {
  const out = bytes.slice();
  out[index] ^= 0x01;
  return out;
}

function serverIntermediate(
  session: Session,
  nonce: Uint8Array,
  box: Uint8Array,
  inner?: Uint8Array,
) {
  return {
    ephPublic: hex(session.ephPublic),
    shared: hex(session.shared),
    key: hex(session.key),
    nonce: hex(nonce),
    box: hex(box),
    ...(inner !== undefined ? { inner: hex(inner) } : {}),
  };
}

function sealCustom(
  sessionId: string,
  label: string,
  inner: Uint8Array,
  prefixed: boolean,
): { session: Session; nonce: Uint8Array; box: Uint8Array; wire: Uint8Array } {
  const session = sessionById(sessionId);
  return { session, ...seal(session, `negative/${label}`, inner, prefixed) };
}

function rawInner(...parts: (number[] | Uint8Array)[]): Uint8Array {
  return concat(...parts.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p))));
}

function padded(inner: Uint8Array): Uint8Array {
  const target = padTarget(inner.length, "client-2");
  return concat(inner, new Uint8Array(target - inner.length));
}

function serverHttpNegative(
  id: string,
  description: string,
  error: string,
  inner: Uint8Array,
  sessionId = "http-a",
): Negative {
  const { session, nonce, box, wire } = sealCustom(sessionId, id, inner, true);
  return {
    id,
    description,
    receiver: "server",
    transport: "http",
    serverSecrets: [hex(SERVER_SECRET)],
    encoding: "raw",
    input: hex(wire),
    intermediate: { wire: hex(wire), ...serverIntermediate(session, nonce, box, inner) },
    error,
  };
}

function clientHttpNegative(
  id: string,
  description: string,
  error: string,
  inner: Uint8Array,
): Negative {
  const { session, nonce, box, wire } = sealCustom("http-a", id, inner, false);
  return {
    id,
    description,
    receiver: "client",
    transport: "http",
    key: hex(session.key),
    encoding: "raw",
    input: hex(wire),
    intermediate: { wire: hex(wire), nonce: hex(nonce), box: hex(box), inner: hex(inner) },
    error,
  };
}

function zeroSharedNegative(id: string, description: string, ephPublic: Uint8Array): Negative {
  const session = sessionById("http-a");
  const template = buildRecord({ ...RECORD_SPECS[0], id: `negative/${id}` });
  const wire = concat(ephPublic, template.record);
  return {
    id,
    description,
    receiver: "server",
    transport: "http",
    serverSecrets: [hex(session.serverSecret)],
    encoding: "raw",
    input: hex(wire),
    intermediate: {
      wire: hex(wire),
      ephPublic: hex(ephPublic),
      shared: hex(new Uint8Array(32)),
    },
    error: "zero-shared",
  };
}

const P_MINUS_1 = "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f";

function buildNegative(records: Map<string, BuiltRecord>): Negative[] {
  const get = (id: string): BuiltRecord => {
    const built = records.get(id);
    if (built === undefined) throw new Error(id);
    return built;
  };
  const getReq = get("http-get");
  const ok = (built: BuiltRecord) => serverIntermediate(built.session, built.nonce, built.box);
  const out: Negative[] = [];

  const badTag = flip(getReq.wire, 32 + 24);
  out.push({
    id: "server-bad-tag",
    description: "http-get with the first tag byte's low bit flipped.",
    receiver: "server",
    transport: "http",
    serverSecrets: [hex(SERVER_SECRET)],
    encoding: "raw",
    input: hex(badTag),
    intermediate: { wire: hex(badTag), ...ok(getReq), box: hex(badTag.subarray(56)) },
    error: "open-failed",
  });

  const badCipher = flip(getReq.wire, getReq.wire.length - 1);
  out.push({
    id: "server-bad-ciphertext",
    description: "http-get with the last ciphertext byte's low bit flipped (a padding byte).",
    receiver: "server",
    transport: "http",
    serverSecrets: [hex(SERVER_SECRET)],
    encoding: "raw",
    input: hex(badCipher),
    intermediate: { wire: hex(badCipher), ...ok(getReq), box: hex(badCipher.subarray(56)) },
    error: "open-failed",
  });

  const badNonce = flip(getReq.wire, 32);
  out.push({
    id: "server-bad-nonce",
    description: "http-get with the first nonce byte's low bit flipped.",
    receiver: "server",
    transport: "http",
    serverSecrets: [hex(SERVER_SECRET)],
    encoding: "raw",
    input: hex(badNonce),
    intermediate: {
      wire: hex(badNonce),
      ...ok(getReq),
      nonce: hex(badNonce.subarray(32, 56)),
    },
    error: "open-failed",
  });

  const retiredShared = sharedSecret(RETIRED_SECRET, getReq.session.ephPublic);
  if (retiredShared === null) throw new Error("retired shared");
  out.push({
    id: "server-wrong-key",
    description: "http-get offered to a server that holds only a different private key.",
    receiver: "server",
    transport: "http",
    serverSecrets: [hex(RETIRED_SECRET)],
    encoding: "raw",
    input: hex(getReq.wire),
    intermediate: {
      wire: hex(getReq.wire),
      ephPublic: hex(getReq.session.ephPublic),
      shared: hex(retiredShared),
      key: hex(sessionKeyOf(retiredShared)),
      nonce: hex(getReq.nonce),
      box: hex(getReq.box),
    },
    error: "open-failed",
  });

  out.push(zeroSharedNegative("server-zero-shared-u0", "ephPublic is u = 0.", new Uint8Array(32)));
  const zeroTop = new Uint8Array(32);
  zeroTop[31] = 0x80;
  out.push(
    zeroSharedNegative(
      "server-zero-shared-u0-top-bit",
      "ephPublic is u = 0 with the top bit set, which X25519 masks to u = 0.",
      zeroTop,
    ),
  );
  const one = new Uint8Array(32);
  one[0] = 1;
  out.push(zeroSharedNegative("server-zero-shared-u1", "ephPublic is u = 1 (order 4).", one));
  out.push(
    zeroSharedNegative(
      "server-zero-shared-order-8",
      "ephPublic is a point of order 8 (libsodium's small_order_p).",
      fromHex("e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800"),
    ),
  );
  out.push(
    zeroSharedNegative(
      "server-zero-shared-p-minus-1",
      "ephPublic is u = p - 1 (order 2).",
      fromHex(P_MINUS_1),
    ),
  );
  out.push(
    zeroSharedNegative(
      "server-zero-shared-p",
      "ephPublic is u = p, the non-canonical encoding of 0.",
      fromHex("edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
    ),
  );

  const short = getReq.wire.subarray(0, 32 + 24 + 15);
  out.push({
    id: "server-truncated-short",
    description: "A request wire of 71 bytes, one short of ephPublic + nonce + tag.",
    receiver: "server",
    transport: "http",
    serverSecrets: [hex(SERVER_SECRET)],
    encoding: "raw",
    input: hex(short),
    intermediate: { wire: hex(short) },
    error: "truncated",
  });
  out.push({
    id: "server-truncated-empty",
    description: "An empty raw body.",
    receiver: "server",
    transport: "http",
    serverSecrets: [hex(SERVER_SECRET)],
    encoding: "raw",
    input: "",
    intermediate: { wire: "" },
    error: "truncated",
  });
  const cut = getReq.wire.subarray(0, getReq.wire.length - 1);
  out.push({
    id: "server-truncated-by-one",
    description: "http-get missing its last byte: long enough to try, so the tag check fails.",
    receiver: "server",
    transport: "http",
    serverSecrets: [hex(SERVER_SECRET)],
    encoding: "raw",
    input: hex(cut),
    intermediate: { wire: hex(cut), ...ok(getReq), box: hex(cut.subarray(56)) },
    error: "open-failed",
  });

  const response200 = get("http-200");
  out.push(
    serverHttpNegative(
      "server-wrong-direction",
      "A client-sealed record of kind 2 (http-response) sent to the server.",
      "wrong-direction",
      response200.inner,
    ),
  );
  out.push(
    serverHttpNegative(
      "server-wrong-transport",
      "A kind 3 socket record sent on the HTTP tunnel.",
      "wrong-transport",
      buildInner(3, { text: "hi" }, "client-2").writer.bytesOut(),
    ),
  );
  out.push(
    serverHttpNegative(
      "server-wrong-transport-handshake",
      "A kind 7 socket handshake sent on the HTTP tunnel.",
      "wrong-transport",
      buildInner(7, {}, "client-2").writer.bytesOut(),
    ),
  );
  const v2 = getReq.inner.slice();
  v2[0] = 2;
  out.push(
    serverHttpNegative(
      "server-unsupported-version-2",
      "http-get's inner with version byte 2.",
      "unsupported-version",
      v2,
    ),
  );
  const v0 = getReq.inner.slice();
  v0[0] = 0;
  out.push(
    serverHttpNegative(
      "server-unsupported-version-0",
      "http-get's inner with version byte 0.",
      "unsupported-version",
      v0,
    ),
  );
  out.push(
    serverHttpNegative(
      "server-unknown-kind-8",
      "Kind 8.",
      "unknown-kind",
      padded(rawInner([1, 8])),
    ),
  );
  out.push(
    serverHttpNegative(
      "server-unknown-kind-0",
      "Kind 0.",
      "unknown-kind",
      padded(rawInner([1, 0])),
    ),
  );
  out.push(
    serverHttpNegative(
      "server-malformed-one-byte",
      "An inner of one byte (version only).",
      "malformed",
      rawInner([1]),
    ),
  );
  out.push(
    serverHttpNegative(
      "server-malformed-field-past-end",
      "Kind 1 whose method length (200) runs past the end of an unpadded inner.",
      "malformed",
      rawInner([1, 1, 0xc8, 0x01], utf8("GET")),
    ),
  );
  out.push(
    serverHttpNegative(
      "server-malformed-leb128-non-minimal",
      "Kind 1 whose method length 3 is written as 83 00, a non-minimal LEB128.",
      "malformed",
      padded(rawInner([1, 1, 0x83, 0x00], utf8("GET"), [1], utf8("/"), [0, 0])),
    ),
  );
  out.push(
    serverHttpNegative(
      "server-malformed-leb128-too-long",
      "Kind 1 whose headers count is a six-byte LEB128.",
      "malformed",
      padded(
        rawInner([1, 1, 3], utf8("GET"), [1], utf8("/"), [0x80, 0x80, 0x80, 0x80, 0x80, 0x01]),
      ),
    ),
  );
  out.push(
    serverHttpNegative(
      "server-malformed-utf8",
      "Kind 1 whose method is the single byte ff, invalid UTF-8.",
      "malformed",
      padded(rawInner([1, 1, 1, 0xff, 1], utf8("/"), [0, 0])),
    ),
  );
  out.push(
    serverHttpNegative(
      "server-malformed-target-host",
      "Kind 1 whose target is //evil.example/x, which would name another host.",
      "malformed",
      buildInner(
        1,
        { method: "GET", target: "//evil.example/x", headers: [], body: new Uint8Array() },
        "client-2",
      ).writer.bytesOut(),
    ),
  );
  out.push(
    serverHttpNegative(
      "server-malformed-target-absolute",
      "Kind 1 whose target is an absolute URL.",
      "malformed",
      buildInner(
        1,
        { method: "GET", target: "https://evil.example/x", headers: [], body: new Uint8Array() },
        "client-2",
      ).writer.bytesOut(),
    ),
  );
  out.push(
    serverHttpNegative(
      "server-malformed-header-name",
      "Kind 1 with an upper-case header name.",
      "malformed",
      buildInner(
        1,
        { method: "GET", target: "/", headers: [["Accept", "*/*"]], body: new Uint8Array() },
        "client-2",
      ).writer.bytesOut(),
    ),
  );
  out.push(
    serverHttpNegative(
      "server-malformed-header-value",
      "Kind 1 with a header value holding U+0100, outside a ByteString.",
      "malformed",
      buildInner(
        1,
        { method: "GET", target: "/", headers: [["x-a", "Ā"]], body: new Uint8Array() },
        "client-2",
      ).writer.bytesOut(),
    ),
  );

  const notText = utf8(JSON.stringify({ [JSON_KEY]: "abcde" }));
  out.push({
    id: "server-bad-encoding-json",
    description:
      "A one-key JSON body whose string is neither base64 nor base64url (length mod 4 is 1).",
    receiver: "server",
    transport: "http",
    serverSecrets: [hex(SERVER_SECRET)],
    encoding: "json",
    input: hex(notText),
    inputText: Buffer.from(notText).toString("utf8"),
    intermediate: {},
    error: "bad-encoding",
  });
  const urlText = Buffer.from(getReq.wire).toString("base64url");
  const nonCanonical = `${urlText.slice(0, -1)}${String.fromCharCode(urlText.charCodeAt(urlText.length - 1) + 1)}`;
  out.push({
    id: "server-bad-encoding-non-canonical",
    description:
      "http-get in base64url with its last character raised by one, so the unused low bits are not zero.",
    receiver: "server",
    transport: "http",
    serverSecrets: [hex(SERVER_SECRET)],
    encoding: "base64url",
    input: hex(utf8(nonCanonical)),
    inputText: nonCanonical,
    intermediate: {},
    error: "bad-encoding",
  });
  const mixed = `${urlText.slice(0, 4)}+-${urlText.slice(6)}`;
  out.push({
    id: "server-bad-encoding-mixed-alphabet",
    description: "Text mixing '+' and '-', neither base64 nor base64url.",
    receiver: "server",
    transport: "http",
    serverSecrets: [hex(SERVER_SECRET)],
    encoding: "base64url",
    input: hex(utf8(mixed)),
    inputText: mixed,
    intermediate: {},
    error: "bad-encoding",
  });

  const res = get("http-200");
  const resBadTag = flip(res.wire, 24);
  out.push({
    id: "client-bad-tag",
    description: "http-200 with the first tag byte's low bit flipped.",
    receiver: "client",
    transport: "http",
    key: hex(res.session.key),
    encoding: "raw",
    input: hex(resBadTag),
    intermediate: { wire: hex(resBadTag), nonce: hex(res.nonce), box: hex(resBadTag.subarray(24)) },
    error: "open-failed",
  });
  const resShort = res.wire.subarray(0, 39);
  out.push({
    id: "client-truncated",
    description: "A response wire of 39 bytes, one short of nonce + tag.",
    receiver: "client",
    transport: "http",
    key: hex(res.session.key),
    encoding: "raw",
    input: hex(resShort),
    intermediate: { wire: hex(resShort) },
    error: "truncated",
  });
  out.push(
    clientHttpNegative(
      "client-wrong-direction",
      "A server-sealed record of kind 1 (http-request) sent to the client.",
      "wrong-direction",
      getReq.inner,
    ),
  );
  out.push(
    clientHttpNegative(
      "client-unsupported-version",
      "http-200's inner with version byte 2.",
      "unsupported-version",
      (() => {
        const inner = res.inner.slice();
        inner[0] = 2;
        return inner;
      })(),
    ),
  );
  out.push(
    clientHttpNegative(
      "client-malformed-status-low",
      "Kind 2 with status 199.",
      "malformed",
      buildInner(
        2,
        { status: 199, headers: [], body: new Uint8Array() },
        "server",
      ).writer.bytesOut(),
    ),
  );
  out.push(
    clientHttpNegative(
      "client-malformed-status-high",
      "Kind 2 with status 600.",
      "malformed",
      buildInner(
        2,
        { status: 600, headers: [], body: new Uint8Array() },
        "server",
      ).writer.bytesOut(),
    ),
  );
  const jsonRes = encodeBody(res.wire, "json").body;
  const jsonBroken = utf8(Buffer.from(jsonRes).toString("utf8").replace(/"}$/, '","x":"y"}'));
  out.push({
    id: "client-bad-encoding-json-two-keys",
    description: "A json response object with two properties.",
    receiver: "client",
    transport: "http",
    key: hex(res.session.key),
    encoding: "json",
    input: hex(jsonBroken),
    inputText: Buffer.from(jsonBroken).toString("utf8"),
    intermediate: {},
    error: "bad-encoding",
  });

  const hs = get("socket-binary-handshake");
  const hsShort = hs.wire.subarray(0, 71);
  out.push({
    id: "server-socket-truncated-first",
    description: "A first binary frame of 71 bytes.",
    receiver: "server",
    transport: "socket",
    serverSecrets: [hex(SERVER_SECRET)],
    frameType: "binary",
    frameIndex: 0,
    input: hex(hsShort),
    intermediate: { wire: hex(hsShort) },
    error: "truncated",
  });
  const hsBad = flip(hs.wire, 32 + 24 + 3);
  out.push({
    id: "server-socket-bad-tag",
    description: "socket-binary-handshake with a tag byte flipped.",
    receiver: "server",
    transport: "socket",
    serverSecrets: [hex(SERVER_SECRET)],
    frameType: "binary",
    frameIndex: 0,
    input: hex(hsBad),
    intermediate: { wire: hex(hsBad), ...ok(hs), box: hex(hsBad.subarray(56)) },
    error: "open-failed",
  });
  const socketServerNegative = (
    id: string,
    description: string,
    error: string,
    inner: Uint8Array,
    frameIndex: number,
  ): Negative => {
    const prefixed = frameIndex === 0;
    const { session, nonce, box, wire } = sealCustom("socket-binary", id, inner, prefixed);
    return {
      id,
      description,
      receiver: "server",
      transport: "socket",
      serverSecrets: [hex(SERVER_SECRET)],
      ...(prefixed ? {} : { key: hex(session.key) }),
      frameType: "binary",
      frameIndex,
      input: hex(wire),
      intermediate: prefixed
        ? { wire: hex(wire), ...serverIntermediate(session, nonce, box, inner) }
        : { wire: hex(wire), nonce: hex(nonce), box: hex(box), inner: hex(inner) },
      error,
    };
  };
  out.push(
    socketServerNegative(
      "server-socket-wrong-direction",
      "A first frame of kind 5 (server text).",
      "wrong-direction",
      buildInner(5, { text: "x" }, "client-2").writer.bytesOut(),
      0,
    ),
  );
  out.push(
    socketServerNegative(
      "server-socket-wrong-transport",
      "A first frame of kind 1 (http-request).",
      "wrong-transport",
      getReq.inner,
      0,
    ),
  );
  out.push(
    socketServerNegative(
      "server-socket-unexpected-handshake",
      "Kind 7 in the second client frame.",
      "unexpected-handshake",
      buildInner(7, {}, "client-2").writer.bytesOut(),
      1,
    ),
  );
  out.push(
    socketServerNegative(
      "server-socket-later-wrong-direction",
      "Kind 6 (server binary) in the second client frame.",
      "wrong-direction",
      buildInner(6, { payload: fromHex("00") }, "client-2").writer.bytesOut(),
      1,
    ),
  );
  const first = get("socket-text-first");
  const padText = Buffer.from(first.wire).toString("base64");
  if (padText === Buffer.from(first.wire).toString("base64url")) throw new Error("same text");
  out.push({
    id: "server-socket-text-base64",
    description:
      "socket-text-first sent as standard base64 instead of base64url; socket text frames take base64url only.",
    receiver: "server",
    transport: "socket",
    serverSecrets: [hex(SERVER_SECRET)],
    frameType: "text",
    frameIndex: 0,
    input: hex(utf8(padText)),
    inputText: padText,
    intermediate: {},
    error: "bad-encoding",
  });
  const later = get("socket-binary-client-text");
  out.push({
    id: "server-socket-frame-type-mismatch",
    description:
      "socket-binary-client-text sent as a text frame on a socket whose first frame was binary.",
    receiver: "server",
    transport: "socket",
    serverSecrets: [hex(SERVER_SECRET)],
    key: hex(later.session.key),
    frameType: "binary",
    frameIndex: 1,
    input: hex(utf8(Buffer.from(later.wire).toString("base64url"))),
    inputText: Buffer.from(later.wire).toString("base64url"),
    intermediate: {},
    error: "bad-encoding",
  });

  const serverText = get("socket-binary-server-text");
  const stBad = flip(serverText.wire, serverText.wire.length - 1);
  out.push({
    id: "client-socket-bad-tag",
    description: "socket-binary-server-text with its last byte flipped.",
    receiver: "client",
    transport: "socket",
    key: hex(serverText.session.key),
    frameType: "binary",
    frameIndex: 1,
    input: hex(stBad),
    intermediate: {
      wire: hex(stBad),
      nonce: hex(serverText.nonce),
      box: hex(stBad.subarray(24)),
    },
    error: "open-failed",
  });
  const reflected = get("socket-binary-client-text");
  out.push({
    id: "client-socket-reflected",
    description:
      "The client's own socket-binary-client-text frame reflected back to it: same key, but kind 3 is client to server.",
    receiver: "client",
    transport: "socket",
    key: hex(reflected.session.key),
    frameType: "binary",
    frameIndex: 2,
    input: hex(reflected.wire),
    intermediate: {
      wire: hex(reflected.wire),
      nonce: hex(reflected.nonce),
      box: hex(reflected.box),
      inner: hex(reflected.inner),
    },
    error: "wrong-direction",
  });
  out.push({
    id: "client-reflected-http",
    description:
      "http-get's record (without its ephPublic prefix) reflected back to the client as a response.",
    receiver: "client",
    transport: "http",
    key: hex(getReq.session.key),
    encoding: "raw",
    input: hex(getReq.record),
    intermediate: {
      wire: hex(getReq.record),
      nonce: hex(getReq.nonce),
      box: hex(getReq.box),
      inner: hex(getReq.inner),
    },
    error: "wrong-direction",
  });
  return out;
}

export function buildVectors() {
  const records = new Map<string, BuiltRecord>();
  for (const spec of RECORD_SPECS) records.set(spec.id, buildRecord(spec));
  return {
    $schema: "./np1.schema.json",
    protocol: "NP1",
    version: 1,
    description:
      "Deterministic NP1 vectors. The byte layout and the receiving rules are in np1.schema.json's description. Regenerate with `pnpm vectors` in this package.",
    kinds: KINDS,
    primitives: buildPrimitives(),
    ladders: buildLadders(),
    sessions: SESSIONS.map((s) => ({
      id: s.id,
      description: s.description,
      serverSecret: hex(s.serverSecret),
      serverPublic: hex(s.serverPublic),
      ephSecret: hex(s.ephSecret),
      ephPublicCanonical: hex(s.ephPublicCanonical),
      topBit: s.topBit,
      ephPublic: hex(s.ephPublic),
      shared: hex(s.shared),
      key: hex(s.key),
    })),
    records: [...records.values()].map((r) => r.json),
    bodies: buildBodies(records),
    sockets: buildSockets(records),
    rotation: buildRotation(records),
    negative: buildNegative(records),
  };
}

export function renderFiles(): { vectors: string; schema: string } {
  return {
    vectors: `${JSON.stringify(buildVectors(), null, 2)}\n`,
    schema: `${JSON.stringify(np1Schema, null, 2)}\n`,
  };
}

export const VECTOR_FILES = { vectors: VECTORS_URL, schema: SCHEMA_URL };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = renderFiles();
  writeFileSync(VECTORS_URL, files.vectors);
  writeFileSync(SCHEMA_URL, files.schema);
}
