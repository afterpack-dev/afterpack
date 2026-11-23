const STANDARD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const URL_SAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const BASE64_FORM = /^[A-Za-z0-9+/]*={0,2}$/;
const BASE64URL_FORM = /^[A-Za-z0-9_-]*$/;
const ALPHANUMERIC = /^[A-Za-z0-9]*$/;

const STANDARD_VALUES = valuesOf(STANDARD);
const URL_SAFE_VALUES = valuesOf(URL_SAFE);

function valuesOf(alphabet: string): Int16Array {
  const values = new Int16Array(128).fill(-1);
  for (let i = 0; i < alphabet.length; i++) values[alphabet.charCodeAt(i)] = i;
  return values;
}

function encode(bytes: Uint8Array, alphabet: string, pad: boolean): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      alphabet[n >> 18] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63] + alphabet[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += alphabet[n >> 18] + alphabet[(n >> 12) & 63];
    if (pad) out += "==";
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += alphabet[n >> 18] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63];
    if (pad) out += "=";
  }
  return out;
}

function decodeDigits(text: string, values: Int16Array): Uint8Array | null {
  if (text.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < text.length; i++) {
    const v = values[text.charCodeAt(i)];
    if (v === undefined || v < 0) return null;
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) return null;
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  return encode(bytes, STANDARD, true);
}

export function toBase64url(bytes: Uint8Array): string {
  return encode(bytes, URL_SAFE, false);
}

export function fromBase64(text: string): Uint8Array | null {
  if (text.length % 4 !== 0 || !BASE64_FORM.test(text)) return null;
  const digits = text.replace(/=+$/, "");
  const bytes = decodeDigits(digits, STANDARD_VALUES);
  if (bytes === null || toBase64(bytes) !== text) return null;
  return bytes;
}

export function fromBase64url(text: string): Uint8Array | null {
  if (!BASE64URL_FORM.test(text)) return null;
  const bytes = decodeDigits(text, URL_SAFE_VALUES);
  if (bytes === null || toBase64url(bytes) !== text) return null;
  return bytes;
}

export type TextEncoding = "base64" | "base64url";

export function fromEitherBase64(
  text: string,
): { encoding: TextEncoding; bytes: Uint8Array } | null {
  const standard = fromBase64(text);
  if (standard !== null) {
    return { encoding: ALPHANUMERIC.test(text) ? "base64url" : "base64", bytes: standard };
  }
  const urlSafe = fromBase64url(text);
  return urlSafe === null ? null : { encoding: "base64url", bytes: urlSafe };
}

const FATAL_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const UTF8 = new TextEncoder();

export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return FATAL_UTF8.decode(bytes);
  } catch {
    return null;
  }
}

export function encodeUtf8(text: string): Uint8Array<ArrayBuffer> {
  return UTF8.encode(text);
}

export function toBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data);
}

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}
