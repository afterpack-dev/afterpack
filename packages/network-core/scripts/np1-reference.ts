import { secretboxOpen, sessionKeyOf, sharedSecret } from "../src/crypto.js";

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

export type Encoding = "raw" | "base64" | "base64url" | "json";
export type Receiver = "server" | "client";
export type Transport = "http" | "socket";

export type Fields = {
  method?: string;
  target?: string;
  status?: number;
  headers?: [string, string][];
  body?: string;
  text?: string;
  payload?: string;
};

export type Opened = {
  ok: true;
  kind: number;
  fields: Fields;
  key: Uint8Array;
  keyIndex: number;
  ephPublic?: Uint8Array;
};

export type Refused = { ok: false; error: Np1Error };

const KINDS: Record<number, { direction: Receiver; transport: Transport }> = {
  1: { direction: "server", transport: "http" },
  2: { direction: "client", transport: "http" },
  3: { direction: "server", transport: "socket" },
  4: { direction: "server", transport: "socket" },
  5: { direction: "client", transport: "socket" },
  6: { direction: "client", transport: "socket" },
  7: { direction: "server", transport: "socket" },
};

const TEXT_BYTES = /^[A-Za-z0-9+/=_-]*$/;
const BASE64_FORM = /^[A-Za-z0-9+/]*={0,2}$/;
const BASE64URL_FORM = /^[A-Za-z0-9_-]*$/;
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;
const TARGET = /^\/(?![/\\])[\x21\x22\x24-\x7e]*$/;

class Malformed extends Error {}

const refuse = (error: Np1Error): Refused => ({ ok: false, error });

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

export function decodeText(
  text: string,
): { encoding: "base64" | "base64url"; bytes: Uint8Array } | null {
  if (text.length % 4 === 0 && BASE64_FORM.test(text)) {
    const bytes = Buffer.from(text, "base64");
    if (bytes.toString("base64") !== text) return null;
    const ambiguous = /^[A-Za-z0-9]*$/.test(text);
    return { encoding: ambiguous ? "base64url" : "base64", bytes: new Uint8Array(bytes) };
  }
  return decodeBase64url(text);
}

export function decodeBase64url(text: string): { encoding: "base64url"; bytes: Uint8Array } | null {
  if (text.length % 4 === 1 || !BASE64URL_FORM.test(text)) return null;
  const bytes = Buffer.from(text, "base64url");
  if (bytes.toString("base64url") !== text) return null;
  return { encoding: "base64url", bytes: new Uint8Array(bytes) };
}

function utf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

function singleKeyJson(body: Uint8Array): string | null {
  if (body[0] !== 0x7b) return null;
  let value: unknown;
  try {
    value = JSON.parse(utf8(body));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1) return null;
  const inner = (value as Record<string, unknown>)[keys[0]];
  return typeof inner === "string" ? inner : null;
}

export function detectBody(
  body: Uint8Array,
): { encoding: Encoding; wire: Uint8Array; jsonKey?: string } | Refused {
  const json = singleKeyJson(body);
  if (json !== null) {
    const decoded = decodeText(json);
    if (decoded === null) return refuse("bad-encoding");
    const parsed = JSON.parse(utf8(body)) as Record<string, string>;
    return { encoding: "json", wire: decoded.bytes, jsonKey: Object.keys(parsed)[0] };
  }
  const ascii = Buffer.from(body).toString("latin1");
  if (body.length > 0 && TEXT_BYTES.test(ascii)) {
    const decoded = decodeText(ascii);
    if (decoded === null) return refuse("bad-encoding");
    return { encoding: decoded.encoding, wire: decoded.bytes };
  }
  return { encoding: "raw", wire: body };
}

function decodeKnown(body: Uint8Array, encoding: Encoding): Uint8Array | null {
  if (encoding === "raw") return body;
  if (encoding === "json") {
    const json = singleKeyJson(body);
    return json === null ? null : (decodeText(json)?.bytes ?? null);
  }
  let text: string;
  try {
    text = utf8(body);
  } catch {
    return null;
  }
  return decodeText(text)?.bytes ?? null;
}

class Reader {
  offset = 0;
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
    const out = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  string(): string {
    try {
      return utf8(this.bytesField());
    } catch (error) {
      if (error instanceof Malformed) throw error;
      throw new Malformed();
    }
  }

  headers(): [string, string][] {
    const count = this.uint();
    const out: [string, string][] = [];
    for (let i = 0; i < count; i++) {
      const name = this.string();
      const value = this.string();
      if (!HEADER_NAME.test(name)) throw new Malformed();
      for (const ch of value) {
        const code = ch.codePointAt(0) ?? 0;
        if (code > 0xff || code === 0 || code === 0x0a || code === 0x0d) throw new Malformed();
      }
      out.push([name, value]);
    }
    return out;
  }
}

function parseFields(kind: number, reader: Reader): Fields {
  switch (kind) {
    case 1: {
      const method = reader.string();
      const target = reader.string();
      if (!TOKEN.test(method) || !TARGET.test(target)) throw new Malformed();
      const headers = reader.headers();
      return { method, target, headers, body: hex(reader.bytesField()) };
    }
    case 2: {
      const status = reader.uint();
      if (status < 200 || status > 599) throw new Malformed();
      const headers = reader.headers();
      return { status, headers, body: hex(reader.bytesField()) };
    }
    case 3:
    case 5:
      return { text: reader.string() };
    case 4:
    case 6:
      return { payload: hex(reader.bytesField()) };
    default:
      return {};
  }
}

export function parseInner(
  inner: Uint8Array,
  receiver: Receiver,
  transport: Transport,
  first: boolean,
): { kind: number; fields: Fields } | Refused {
  if (inner.length < 2) return refuse("malformed");
  if (inner[0] !== 1) return refuse("unsupported-version");
  const kind = inner[1];
  const meta = KINDS[kind];
  if (meta === undefined) return refuse("unknown-kind");
  if (meta.direction !== receiver) return refuse("wrong-direction");
  if (meta.transport !== transport) return refuse("wrong-transport");
  if (kind === 7 && !first) return refuse("unexpected-handshake");
  const reader = new Reader(inner.subarray(2));
  try {
    return { kind, fields: parseFields(kind, reader) };
  } catch (error) {
    if (error instanceof Malformed) return refuse("malformed");
    throw error;
  }
}

type Keys = { serverSecrets: Uint8Array[] } | { key: Uint8Array };

export function openWire(
  wire: Uint8Array,
  keys: Keys,
  receiver: Receiver,
  transport: Transport,
  first: boolean,
): Opened | Refused {
  const prefixed = "serverSecrets" in keys;
  const prefix = prefixed ? 32 : 0;
  if (wire.length < prefix + 40) return refuse("truncated");
  const nonce = wire.subarray(prefix, prefix + 24);
  const boxed = wire.subarray(prefix + 24);
  const candidates: Uint8Array[] = [];
  let ephPublic: Uint8Array | undefined;
  if ("serverSecrets" in keys) {
    ephPublic = wire.subarray(0, 32);
    for (const secret of keys.serverSecrets) {
      const shared = sharedSecret(secret, ephPublic);
      if (shared === null) return refuse("zero-shared");
      candidates.push(sessionKeyOf(shared));
    }
  } else {
    candidates.push(keys.key);
  }
  for (let index = 0; index < candidates.length; index++) {
    const inner = secretboxOpen(candidates[index], nonce, boxed);
    if (inner === null) continue;
    const parsed = parseInner(inner, receiver, transport, first);
    if ("ok" in parsed) return parsed;
    return { ok: true, ...parsed, key: candidates[index], keyIndex: index, ephPublic };
  }
  return refuse("open-failed");
}

export function openRequestBody(
  body: Uint8Array,
  serverSecrets: Uint8Array[],
): (Opened & { encoding: Encoding; jsonKey?: string }) | Refused {
  const detected = detectBody(body);
  if ("ok" in detected) return detected;
  const opened = openWire(detected.wire, { serverSecrets }, "server", "http", true);
  if (!opened.ok) return opened;
  return { ...opened, encoding: detected.encoding, jsonKey: detected.jsonKey };
}

export function openResponseBody(
  body: Uint8Array,
  key: Uint8Array,
  encoding: Encoding,
): Opened | Refused {
  const wire = decodeKnown(body, encoding);
  if (wire === null) return refuse("bad-encoding");
  return openWire(wire, { key }, "client", "http", false);
}

export function frameWire(
  frame: Uint8Array | string,
  frameType: "binary" | "text",
): Uint8Array | null {
  if (frameType === "binary") return typeof frame === "string" ? null : frame;
  if (typeof frame !== "string") return null;
  return decodeBase64url(frame)?.bytes ?? null;
}

export function openSocketFrame(
  frame: Uint8Array | string,
  frameType: "binary" | "text",
  receiver: Receiver,
  frameIndex: number,
  keys: Keys,
): Opened | Refused {
  const wire = frameWire(frame, frameType);
  if (wire === null) return refuse("bad-encoding");
  return openWire(wire, keys, receiver, "socket", frameIndex === 0);
}
