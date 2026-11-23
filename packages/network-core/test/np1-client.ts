import { randomBytes } from "node:crypto";
import nacl from "tweetnacl";

export type Encoding = "raw" | "base64" | "base64url" | "json";
export type FrameType = "binary" | "text";
export type Pairs = [string, string][];

export const CONTENT_TYPES: Record<Encoding, string> = {
  raw: "application/octet-stream",
  base64: "text/plain;charset=UTF-8",
  base64url: "text/plain;charset=UTF-8",
  json: "application/json",
};

function leb128(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  for (;;) {
    const low = rest & 0x7f;
    rest = Math.floor(rest / 128);
    if (rest === 0) {
      out.push(low);
      return out;
    }
    out.push(low | 0x80);
  }
}

function lengthPrefixed(bytes: Uint8Array): number[] {
  return [...leb128(bytes.length), ...bytes];
}

function text(value: string): number[] {
  return lengthPrefixed(new Uint8Array(Buffer.from(value, "utf8")));
}

function pairs(headers: Pairs): number[] {
  const out = leb128(headers.length);
  for (const [name, value] of headers) out.push(...text(name), ...text(value));
  return out;
}

export function ladder(length: number, ratio: number | null): number {
  if (ratio === null) return length;
  let bucket = 256;
  let step = 0;
  while (bucket < 65536) {
    if (length <= bucket) return bucket;
    step += 1;
    bucket = Math.ceil(256 * ratio ** step);
  }
  return Math.ceil(length / 65536) * 65536;
}

function pad(unpadded: number[], ratio: number | null, padByte: number): Uint8Array {
  const out = new Uint8Array(ladder(unpadded.length, ratio)).fill(padByte);
  out.set(unpadded);
  return out;
}

class Cursor {
  at = 0;
  constructor(readonly bytes: Uint8Array) {}
  uint(): number {
    let value = 0;
    let scale = 1;
    for (;;) {
      const byte = this.bytes[this.at++];
      if (byte === undefined) throw new Error("short");
      value += (byte & 0x7f) * scale;
      scale *= 128;
      if (byte < 0x80) return value;
    }
  }
  field(): Uint8Array {
    const length = this.uint();
    const out = this.bytes.slice(this.at, this.at + length);
    if (out.length !== length) throw new Error("short");
    this.at += length;
    return out;
  }
  string(): string {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(this.field());
  }
}

export function wireFromText(value: string): Uint8Array {
  const alphabet = /[+/=]/.test(value) ? "base64" : "base64url";
  const bytes = Buffer.from(value, alphabet);
  if (bytes.toString(alphabet) !== value) throw new Error(`non-canonical ${alphabet}`);
  return new Uint8Array(bytes);
}

export function wireToText(wire: Uint8Array, alphabet: "base64" | "base64url"): string {
  return Buffer.from(wire).toString(alphabet);
}

export interface ClientOptions {
  serverPublic: Uint8Array;
  ephSecret?: Uint8Array;
  topBit?: 0 | 1;
  ratio?: number | null;
  nonce?: () => Uint8Array;
  padByte?: number;
}

export interface SealedRequest {
  body: Uint8Array;
  contentType: string;
  wire: Uint8Array;
}

export interface OpenedResponse {
  status: number;
  headers: Pairs;
  body: Uint8Array;
}

export class Np1TestClient {
  readonly key: Uint8Array;
  readonly ephPublic: Uint8Array;
  private readonly ratio: number | null;
  private readonly nonce: () => Uint8Array;
  private readonly padByte: number;

  constructor(options: ClientOptions) {
    const secret = options.ephSecret ?? nacl.randomBytes(32);
    const pair = nacl.box.keyPair.fromSecretKey(secret);
    const topBit = options.topBit ?? randomBytes(1)[0] & 1;
    this.ephPublic = pair.publicKey.slice();
    this.ephPublic[31] = (this.ephPublic[31] & 0x7f) | (topBit << 7);
    this.key = nacl.box.before(options.serverPublic, secret);
    this.ratio = options.ratio === undefined ? 1.5 : options.ratio;
    this.nonce = options.nonce ?? (() => nacl.randomBytes(24));
    this.padByte = options.padByte ?? 0;
  }

  record(inner: Uint8Array): Uint8Array {
    const nonce = this.nonce();
    const box = nacl.secretbox(inner, nonce, this.key);
    const out = new Uint8Array(24 + box.length);
    out.set(nonce);
    out.set(box, 24);
    return out;
  }

  prefixed(record: Uint8Array): Uint8Array {
    const out = new Uint8Array(32 + record.length);
    out.set(this.ephPublic);
    out.set(record, 32);
    return out;
  }

  requestInner(method: string, target: string, headers: Pairs, body: Uint8Array): Uint8Array {
    const fields = [
      1,
      1,
      ...text(method),
      ...text(target),
      ...pairs(headers),
      ...lengthPrefixed(body),
    ];
    return pad(fields, this.ratio, this.padByte);
  }

  sealRequest(
    request: { method: string; target: string; headers?: Pairs; body?: Uint8Array | string },
    encoding: Encoding,
    jsonKey = "q7",
  ): SealedRequest {
    const body =
      typeof request.body === "string"
        ? new Uint8Array(Buffer.from(request.body, "utf8"))
        : (request.body ?? new Uint8Array(0));
    const inner = this.requestInner(request.method, request.target, request.headers ?? [], body);
    const wire = this.prefixed(this.record(inner));
    return {
      body: encodeOuter(wire, encoding, jsonKey),
      contentType: CONTENT_TYPES[encoding],
      wire,
    };
  }

  openResponse(body: Uint8Array, encoding: Encoding): OpenedResponse {
    const cursor = this.openRecord(decodeOuter(body, encoding), 2);
    const status = cursor.uint();
    const headers: Pairs = [];
    const count = cursor.uint();
    for (let i = 0; i < count; i++) headers.push([cursor.string(), cursor.string()]);
    return { status, headers, body: cursor.field() };
  }

  openRecord(wire: Uint8Array, expectKind: number): Cursor {
    const inner = nacl.secretbox.open(wire.subarray(24), wire.subarray(0, 24), this.key);
    if (inner === null) throw new Error("open-failed");
    if (inner[0] !== 1) throw new Error("unsupported-version");
    if (inner[1] !== expectKind) throw new Error(`kind ${inner[1]}, expected ${expectKind}`);
    const cursor = new Cursor(inner);
    cursor.at = 2;
    return cursor;
  }

  socketInner(message: string | Uint8Array | null): Uint8Array {
    if (message === null) return pad([1, 7], this.ratio, this.padByte);
    if (typeof message === "string") return pad([1, 3, ...text(message)], this.ratio, this.padByte);
    return pad([1, 4, ...lengthPrefixed(message)], this.ratio, this.padByte);
  }

  socketFrame(
    message: string | Uint8Array | null,
    frameType: FrameType,
    first: boolean,
  ): string | Uint8Array {
    const record = this.record(this.socketInner(message));
    const wire = first ? this.prefixed(record) : record;
    return frameType === "binary" ? wire : wireToText(wire, "base64url");
  }

  openSocketFrame(frame: string | Uint8Array): string | Uint8Array {
    const wire = typeof frame === "string" ? wireFromText(frame) : frame;
    const inner = nacl.secretbox.open(wire.subarray(24), wire.subarray(0, 24), this.key);
    if (inner === null || inner[0] !== 1) throw new Error("open-failed");
    const cursor = new Cursor(inner);
    cursor.at = 2;
    if (inner[1] === 5) return cursor.string();
    if (inner[1] === 6) return cursor.field();
    throw new Error(`kind ${inner[1]} from the server`);
  }
}

export function encodeOuter(wire: Uint8Array, encoding: Encoding, jsonKey = "q7"): Uint8Array {
  switch (encoding) {
    case "raw":
      return wire;
    case "base64":
      return new Uint8Array(Buffer.from(wireToText(wire, "base64"), "ascii"));
    case "base64url":
      return new Uint8Array(Buffer.from(wireToText(wire, "base64url"), "ascii"));
    case "json":
      return new Uint8Array(
        Buffer.from(`{${JSON.stringify(jsonKey)}:"${wireToText(wire, "base64url")}"}`, "utf8"),
      );
  }
}

export function decodeOuter(body: Uint8Array, encoding: Encoding): Uint8Array {
  if (encoding === "raw") return body;
  const asText = Buffer.from(body).toString("utf8");
  if (encoding === "json") {
    const parsed = JSON.parse(asText) as Record<string, unknown>;
    const values = Object.values(parsed);
    if (values.length !== 1 || typeof values[0] !== "string") throw new Error("bad-encoding");
    return wireFromText(values[0]);
  }
  return wireFromText(asText);
}
