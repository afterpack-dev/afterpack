import { toHex } from "./bytes.js";
import { deriveSessionKey, PUBLIC_KEY_BYTES } from "./crypto.js";
import type { SessionKeys } from "./np1.js";

export const SESSION_CACHE_SIZE = 4096;

const CACHE_KEY = Symbol.for("@afterpack/network-core.session-cache");

type Cache = Map<string, Uint8Array[] | "zero-shared">;

function cache(): Cache {
  const holder = globalThis as { [CACHE_KEY]?: Cache };
  holder[CACHE_KEY] ??= new Map();
  return holder[CACHE_KEY];
}

export function maskedEphPublic(ephPublic: Uint8Array): Uint8Array {
  const masked = ephPublic.slice(0, PUBLIC_KEY_BYTES);
  masked[31] &= 0x7f;
  return masked;
}

export interface SessionDeriver {
  id: string;
  secrets: Uint8Array[];
}

function cacheKey(deriver: SessionDeriver, ephPublic: Uint8Array): string {
  return `${deriver.id}:${toHex(maskedEphPublic(ephPublic))}`;
}

export function isCachedSession(deriver: SessionDeriver, ephPublic: Uint8Array): boolean {
  return cache().has(cacheKey(deriver, ephPublic));
}

export function sessionKeysFor(deriver: SessionDeriver, ephPublic: Uint8Array): SessionKeys {
  const entries = cache();
  const key = cacheKey(deriver, ephPublic);
  const hit = entries.get(key);
  if (hit !== undefined) {
    entries.delete(key);
    entries.set(key, hit);
    return hit === "zero-shared" ? hit : { keys: hit };
  }
  const derived = deriveAll(deriver.secrets, ephPublic);
  entries.set(key, derived);
  while (entries.size > SESSION_CACHE_SIZE) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
  return derived === "zero-shared" ? derived : { keys: derived };
}

export function deriveAll(
  secrets: Uint8Array[],
  ephPublic: Uint8Array,
): Uint8Array[] | "zero-shared" {
  const keys: Uint8Array[] = [];
  for (const secret of secrets) {
    const key = deriveSessionKey(secret, ephPublic);
    if (key === null) return "zero-shared";
    keys.push(key);
  }
  return keys;
}
