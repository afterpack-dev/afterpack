import { describe, expect, it } from "vitest";
import { publicKeyOf } from "./crypto.js";
import {
  isCachedSession,
  maskedEphPublic,
  SESSION_CACHE_SIZE,
  sessionKeysFor,
} from "./session-cache.js";

function key(seed: number): Uint8Array {
  const out = new Uint8Array(32);
  new DataView(out.buffer).setUint32(0, seed);
  out[31] = 0x40;
  return out;
}

describe("the per-isolate session cache", () => {
  it("keeps the most recent sessions and evicts the least recently used", () => {
    const deriver = { id: `lru-${Math.random()}`, secrets: [key(1)] };
    const ephs = Array.from({ length: SESSION_CACHE_SIZE + 1 }, (_, i) => publicKeyOf(key(i + 2)));
    sessionKeysFor(deriver, ephs[0]);
    sessionKeysFor(deriver, ephs[1]);
    for (let i = 2; i < SESSION_CACHE_SIZE; i++) sessionKeysFor(deriver, ephs[i]);
    sessionKeysFor(deriver, ephs[0]);
    sessionKeysFor(deriver, ephs[SESSION_CACHE_SIZE]);
    expect(isCachedSession(deriver, ephs[0])).toBe(true);
    expect(isCachedSession(deriver, ephs[1])).toBe(false);
    expect(isCachedSession(deriver, ephs[SESSION_CACHE_SIZE])).toBe(true);
  }, 30_000);

  it("caches a low-order eph_public as zero-shared", () => {
    const deriver = { id: `zero-${Math.random()}`, secrets: [key(1)] };
    expect(sessionKeysFor(deriver, new Uint8Array(32))).toBe("zero-shared");
    expect(isCachedSession(deriver, new Uint8Array(32))).toBe(true);
  });

  it("masks the top bit of eph_public", () => {
    const eph = new Uint8Array(32).fill(0xff);
    expect(maskedEphPublic(eph)[31]).toBe(0x7f);
    expect(eph[31]).toBe(0xff);
  });
});
