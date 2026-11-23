import {
  concat,
  decodeUtf8,
  encodeUtf8,
  fromBase64url,
  fromEitherBase64,
  type TextEncoding,
  toBase64,
  toBase64url,
} from "./bytes.js";
import {
  NONCE_BYTES,
  PUBLIC_KEY_BYTES,
  secretboxOpen,
  secretboxSeal,
  TAG_BYTES,
} from "./crypto.js";

export type Np1Error =
  | "bad-encoding"
  | "truncated"
  | "zero-shared"
  | "open-failed"
  | "malformed"
  | "unsupported-version"
  | "unknown-kind"
  | "wrong-direction"
  | "wrong-transport"
  | "unexpected-handshake";

export type BodyEncoding = "raw" | TextEncoding | "json";
export type FrameType = "binary" | "text";
type Receiver = "server" | "client";
type Transport = "http" | "socket";

export const VERSION = 1;
export const KIND = {
  httpRequest: 1,
  httpResponse: 2,
  socketClientText: 3,
  socketClientBinary: 4,
  socketServerText: 5,
  socketServerBinary: 6,
  socketHandshake: 7,
} as const;

const KINDS: Record<number, { receiver: Receiver; transport: Transport }> = {
  1: { receiver: "server", transport: "http" },
  2: { receiver: "client", transport: "http" },
  3: { receiver: "server", transport: "socket" },
  4: { receiver: "server", transport: "socket" },
  5: { receiver: "client", transport: "socket" },
  6: { receiver: "client", transport: "socket" },
  7: { receiver: "server", transport: "socket" },
};

export const RECORD_OVERHEAD = NONCE_BYTES + TAG_BYTES;
export const MIN_PREFIXED_WIRE = PUBLIC_KEY_BYTES + RECORD_OVERHEAD;

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;
const TARGET = /^\/(?![/\\])[\x21\x22\x24-\x7e]*$/;

export type HeaderPairs = [string, string][];

export type InnerMessage =
  | { kind: 1; method: string; target: string; headers: HeaderPairs; body: Uint8Array }
  | { kind: 2; status: number; headers: HeaderPairs; body: Uint8Array }
  | { kind: 3 | 5; text: string }
  | { kind: 4 | 6; payload: Uint8Array }
  | { kind: 7 };

export type Refusal = { ok: false; error: Np1Error };
export type Opened = { ok: true; message: InnerMessage; key: Uint8Array };

const refuse = (error: Np1Error): Refusal => ({ ok: false, error });

class Malformed extends Error {}

class Reader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  uint(): number {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      if (this.offset >= this.bytes.length) throw new Malformed();
      const byte = this.bytes[this.offset++];
      value += (byte & 0x7f) * 2 ** (7 * i);
      if ((byte & 0x80) === 0) {
        if (i > 0 && byte === 0) throw new Malformed();
        if (value > 0xffffffff) throw new Malformed();
        return value;
      }
    }
    throw new Malformed();
  }

  bytesField(): Uint8Array {
    const length = this.uint();
    if (length > this.bytes.length - this.offset) throw new Malformed();
    const out = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  string(): string {
    const text = decodeUtf8(this.bytesField());
    if (text === null) throw new Malformed();
    return text;
  }

  headers(): HeaderPairs {
    const count = this.uint();
    const out: HeaderPairs = [];
    for (let i = 0; i < count; i++) {
      const name = this.string();
      const value = this.string();
      if (!HEADER_NAME.test(name) || !isHeaderValue(value)) throw new Malformed();
      out.push([name, value]);
    }
    return out;
  }
}

export function isHeaderValue(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code > 0xff || code === 0 || code === 0x0a || code === 0x0d) return false;
  }
  return true;
}

function parseFields(kind: number, reader: Reader): InnerMessage {
  switch (kind) {
    case 1: {
      const method = reader.string();
      const target = reader.string();
      if (!TOKEN.test(method) || !TARGET.test(target)) throw new Malformed();
      const headers = reader.headers();
      return { kind, method, target, headers, body: reader.bytesField() };
    }
    case 2: {
      const status = reader.uint();
      if (status < 200 || status > 599) throw new Malformed();
      const headers = reader.headers();
      return { kind, status, headers, body: reader.bytesField() };
    }
    case 3:
    case 5:
      return { kind, text: reader.string() };
    case 4:
    case 6:
      return { kind, payload: reader.bytesField() };
    default:
      return { kind: 7 };
  }
}

export function parseInner(
  inner: Uint8Array,
  receiver: Receiver,
  transport: Transport,
  first: boolean,
): { ok: true; message: InnerMessage } | Refusal {
  if (inner.length < 2) return refuse("malformed");
  if (inner[0] !== VERSION) return refuse("unsupported-version");
  const kind = inner[1];
  const meta = KINDS[kind];
  if (meta === undefined) return refuse("unknown-kind");
  if (meta.receiver !== receiver) return refuse("wrong-direction");
  if (meta.transport !== transport) return refuse("wrong-transport");
  if (kind === KIND.socketHandshake && !first) return refuse("unexpected-handshake");
  try {
    return { ok: true, message: parseFields(kind, new Reader(inner.subarray(2))) };
  } catch (error) {
    if (error instanceof Malformed) return refuse("malformed");
    throw error;
  }
}

export type SessionKeys = { keys: Uint8Array[] } | "zero-shared";

export function openRecord(
  wire: Uint8Array,
  keys: { prefixed: (ephPublic: Uint8Array) => SessionKeys } | { key: Uint8Array },
  receiver: Receiver,
  transport: Transport,
  first: boolean,
): Opened | Refusal {
  const prefix = "prefixed" in keys ? PUBLIC_KEY_BYTES : 0;
  if (wire.length < prefix + RECORD_OVERHEAD) return refuse("truncated");
  let candidates: Uint8Array[];
  if ("prefixed" in keys) {
    const derived = keys.prefixed(wire.subarray(0, PUBLIC_KEY_BYTES));
    if (derived === "zero-shared") return refuse("zero-shared");
    candidates = derived.keys;
  } else {
    candidates = [keys.key];
  }
  const nonce = wire.subarray(prefix, prefix + NONCE_BYTES);
  const boxed = wire.subarray(prefix + NONCE_BYTES);
  for (const key of candidates) {
    const inner = secretboxOpen(key, nonce, boxed);
    if (inner === null) continue;
    const parsed = parseInner(inner, receiver, transport, first);
    if (!parsed.ok) return parsed;
    return { ok: true, message: parsed.message, key };
  }
  return refuse("open-failed");
}

function uint(value: number): Uint8Array {
  const out: number[] = [];
  let rest = value;
  do {
    let byte = rest % 128;
    rest = Math.floor(rest / 128);
    if (rest > 0) byte |= 0x80;
    out.push(byte);
  } while (rest > 0);
  return new Uint8Array(out);
}

function bytesField(bytes: Uint8Array): Uint8Array {
  return concat(uint(bytes.length), bytes);
}

function headersField(headers: HeaderPairs): Uint8Array {
  const parts = [uint(headers.length)];
  for (const [name, value] of headers) {
    parts.push(bytesField(encodeUtf8(name)), bytesField(encodeUtf8(value)));
  }
  return concat(...parts);
}

export function ladderBucket(length: number, ratio: number): number {
  for (let i = 0; ; i++) {
    const bucket = Math.ceil(256 * ratio ** i);
    if (bucket >= 65536) break;
    if (bucket >= length) return bucket;
  }
  return Math.max(1, Math.ceil(length / 65536)) * 65536;
}

export const SERVER_LADDER_RATIO = 2;

export function buildInner(message: InnerMessage, ratio: number): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([VERSION, message.kind])];
  switch (message.kind) {
    case 1:
      parts.push(
        bytesField(encodeUtf8(message.method)),
        bytesField(encodeUtf8(message.target)),
        headersField(message.headers),
        bytesField(message.body),
      );
      break;
    case 2:
      parts.push(uint(message.status), headersField(message.headers), bytesField(message.body));
      break;
    case 3:
    case 5:
      parts.push(bytesField(encodeUtf8(message.text)));
      break;
    case 4:
    case 6:
      parts.push(bytesField(message.payload));
      break;
  }
  const unpadded = concat(...parts);
  const padded = new Uint8Array(ladderBucket(unpadded.length, ratio));
  padded.set(unpadded);
  return padded;
}

export function sealRecord(
  key: Uint8Array,
  nonce: Uint8Array,
  inner: Uint8Array,
): Uint8Array<ArrayBuffer> {
  return concat(nonce, secretboxSeal(key, nonce, inner));
}

function singleKeyJson(body: Uint8Array): { key: string; value: string } | null {
  if (body[0] !== 0x7b) return null;
  const text = decodeUtf8(body);
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 1) return null;
  const value = (parsed as Record<string, unknown>)[keys[0]];
  return typeof value === "string" ? { key: keys[0], value } : null;
}

const TEXT_BYTE = new Uint8Array(256);
for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=-_") {
  TEXT_BYTE[ch.charCodeAt(0)] = 1;
}

function isTextBytes(body: Uint8Array): boolean {
  if (body.length === 0) return false;
  for (const byte of body) if (TEXT_BYTE[byte] === 0) return false;
  return true;
}

function latin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return out;
}

export type DetectedBody = { ok: true; encoding: BodyEncoding; wire: Uint8Array; jsonKey?: string };

export function detectBody(body: Uint8Array): DetectedBody | Refusal {
  const json = singleKeyJson(body);
  if (json !== null) {
    const decoded = fromEitherBase64(json.value);
    if (decoded === null) return refuse("bad-encoding");
    return { ok: true, encoding: "json", wire: decoded.bytes, jsonKey: json.key };
  }
  if (isTextBytes(body)) {
    const decoded = fromEitherBase64(latin1(body));
    if (decoded === null) return refuse("bad-encoding");
    return { ok: true, encoding: decoded.encoding, wire: decoded.bytes };
  }
  return { ok: true, encoding: "raw", wire: body };
}

export function encodeBody(
  wire: Uint8Array<ArrayBuffer>,
  encoding: BodyEncoding,
  jsonKey?: string,
): Uint8Array<ArrayBuffer> {
  switch (encoding) {
    case "raw":
      return wire;
    case "base64":
      return encodeUtf8(toBase64(wire));
    case "base64url":
      return encodeUtf8(toBase64url(wire));
    case "json":
      return encodeUtf8(JSON.stringify({ [jsonKey ?? ""]: toBase64url(wire) }));
  }
}

export function frameToWire(frame: string | Uint8Array, frameType: FrameType): Uint8Array | null {
  if (frameType === "binary") return typeof frame === "string" ? null : frame;
  if (typeof frame !== "string") return null;
  return fromBase64url(frame);
}

export function wireToFrame(wire: Uint8Array, frameType: FrameType): string | Uint8Array {
  return frameType === "binary" ? wire : toBase64url(wire);
}
