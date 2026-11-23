import { x25519 } from "@noble/curves/ed25519.js";
import { fromBase64url, toBase64url } from "./bytes.js";
import { publicKeyOf, SECRET_KEY_BYTES } from "./crypto.js";

export type PrivateKeysInput = string | Uint8Array | ReadonlyArray<string | Uint8Array>;

export interface KeyPair {
  publicKey: string;
  privateKey: string;
}

export function generateKeyPair(): KeyPair {
  const secret = x25519.utils.randomSecretKey();
  return { publicKey: toBase64url(publicKeyOf(secret)), privateKey: toBase64url(secret) };
}

export function publicKeyFor(privateKey: string): string {
  return toBase64url(publicKeyOf(parseKey(privateKey, 0)));
}

function parseKey(key: string | Uint8Array, index: number): Uint8Array {
  if (key instanceof Uint8Array) {
    if (key.length !== SECRET_KEY_BYTES) {
      throw new TypeError(`privateKeys[${index}] must be ${SECRET_KEY_BYTES} bytes`);
    }
    return key.slice();
  }
  const bytes = fromBase64url(key);
  if (bytes === null || bytes.length !== SECRET_KEY_BYTES) {
    throw new TypeError(
      `privateKeys[${index}] must be ${SECRET_KEY_BYTES} bytes in base64url, as \`afterpack network keygen\` prints it`,
    );
  }
  return bytes;
}

export function parsePrivateKeys(input: PrivateKeysInput): Uint8Array[] {
  const list: (string | Uint8Array)[] =
    typeof input === "string"
      ? input.split(/[\s,]+/).filter((part) => part !== "")
      : input instanceof Uint8Array
        ? [input]
        : [...input];
  if (list.length === 0) {
    throw new TypeError("privateKeys must hold at least one key");
  }
  return list.map(parseKey);
}
