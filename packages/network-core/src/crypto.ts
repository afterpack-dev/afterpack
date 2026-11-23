import { hsalsa, xsalsa20poly1305 } from "@noble/ciphers/salsa.js";
import { u8, u32 } from "@noble/ciphers/utils.js";
import { x25519 } from "@noble/curves/ed25519.js";

export const PUBLIC_KEY_BYTES = 32;
export const SECRET_KEY_BYTES = 32;
export const SESSION_KEY_BYTES = 32;
export const NONCE_BYTES = 24;
export const TAG_BYTES = 16;

const SIGMA = new Uint8Array([
  0x65, 0x78, 0x70, 0x61, 0x6e, 0x64, 0x20, 0x33, 0x32, 0x2d, 0x62, 0x79, 0x74, 0x65, 0x20, 0x6b,
]);
const ZERO_16 = new Uint8Array(16);

function expectLength(bytes: Uint8Array, length: number, name: string): void {
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
    throw new TypeError(`${name} must be ${length} bytes`);
  }
}

export function publicKeyOf(secretKey: Uint8Array): Uint8Array {
  expectLength(secretKey, SECRET_KEY_BYTES, "secretKey");
  return x25519.getPublicKey(secretKey);
}

export function sharedSecret(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array | null {
  expectLength(secretKey, SECRET_KEY_BYTES, "secretKey");
  expectLength(publicKey, PUBLIC_KEY_BYTES, "publicKey");
  try {
    const shared = x25519.getSharedSecret(secretKey, publicKey);
    let bits = 0;
    for (const byte of shared) bits |= byte;
    return bits === 0 ? null : shared;
  } catch {
    return null;
  }
}

export function hsalsa20(key: Uint8Array, input: Uint8Array): Uint8Array {
  expectLength(key, 32, "key");
  expectLength(input, 16, "input");
  const out = new Uint32Array(8);
  hsalsa(u32(SIGMA.slice()), u32(key.slice()), u32(input.slice()), out);
  return u8(out);
}

export function sessionKeyOf(shared: Uint8Array): Uint8Array {
  return hsalsa20(shared, ZERO_16);
}

export function deriveSessionKey(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array | null {
  const shared = sharedSecret(secretKey, publicKey);
  return shared === null ? null : sessionKeyOf(shared);
}

export function secretboxSeal(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array {
  expectLength(key, SESSION_KEY_BYTES, "key");
  expectLength(nonce, NONCE_BYTES, "nonce");
  return xsalsa20poly1305(key, nonce).encrypt(plaintext);
}

export function secretboxOpen(
  key: Uint8Array,
  nonce: Uint8Array,
  boxed: Uint8Array,
): Uint8Array | null {
  expectLength(key, SESSION_KEY_BYTES, "key");
  expectLength(nonce, NONCE_BYTES, "nonce");
  if (boxed.length < TAG_BYTES) return null;
  try {
    return xsalsa20poly1305(key, nonce).decrypt(boxed);
  } catch {
    return null;
  }
}
