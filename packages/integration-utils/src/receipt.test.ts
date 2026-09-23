import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectAlreadyObfuscatedInputs,
  PROTECTION_RECEIPT_FILE,
  sha256Of,
  UnreadableReceiptError,
  verifyProtectionReceipt,
  writeProtectionReceipt,
} from "./receipt.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "afterpack-receipt-test-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function receiptAt(dir: string, files: string[]): string {
  return writeProtectionReceipt({
    dir,
    tool: "afterpack-test",
    engine: "local",
    engineVersion: null,
    seed: 1,
    seedOrigin: "fresh",
    bundler: "test",
    buildId: null,
    files,
    transformed: files,
  });
}

describe("detectAlreadyObfuscatedInputs", () => {
  it("returns null when no receipt exists anywhere at/above startDir", () => {
    const dir = join(root, "dist");
    mkdirSync(dir, { recursive: true });
    const a = join(dir, "a.js");
    writeFileSync(a, "export const a = 1;");
    expect(detectAlreadyObfuscatedInputs([a], dir)).toBeNull();
  });

  it("is no signal for a malformed (non-JSON) receipt", () => {
    const dir = join(root, "dist");
    mkdirSync(dir, { recursive: true });
    const a = join(dir, "a.js");
    writeFileSync(a, "export const a = 1;");
    writeFileSync(join(dir, PROTECTION_RECEIPT_FILE), "not json");
    expect(detectAlreadyObfuscatedInputs([a], dir)).toBeNull();
  });

  it("reads the fields it knows from a newer receipt schema, so the guard still fires", () => {
    const dir = join(root, "dist");
    mkdirSync(dir, { recursive: true });
    const a = join(dir, "a.js");
    writeFileSync(a, "export const a = 1;");
    writeFileSync(
      join(dir, PROTECTION_RECEIPT_FILE),
      JSON.stringify({
        schema: 99,
        futureField: { anything: true },
        files: [{ path: "a.js", sha256: sha256Of(a), transformed: true, extra: 1 }],
      }),
    );
    expect(detectAlreadyObfuscatedInputs([a], dir)?.files).toEqual([a]);
  });

  it("refuses loudly on a newer schema whose files it cannot read, never treating them as unprotected", () => {
    const dir = join(root, "dist");
    mkdirSync(dir, { recursive: true });
    const a = join(dir, "a.js");
    writeFileSync(a, "export const a = 1;");
    writeFileSync(
      join(dir, PROTECTION_RECEIPT_FILE),
      JSON.stringify({ schema: 2, outputs: { "a.js": sha256Of(a) } }),
    );
    expect(() => detectAlreadyObfuscatedInputs([a], dir)).toThrow(UnreadableReceiptError);
    expect(() => detectAlreadyObfuscatedInputs([a], dir)).toThrow(/receipt schema 2/);
  });

  it("verifies a newer-schema receipt by the fields it knows", () => {
    const dir = join(root, "dist");
    mkdirSync(dir, { recursive: true });
    const a = join(dir, "a.js");
    writeFileSync(a, "OBF");
    writeFileSync(
      join(dir, PROTECTION_RECEIPT_FILE),
      JSON.stringify({
        schema: 3,
        buildId: null,
        files: [{ path: "a.js", sha256: sha256Of(a), transformed: true }],
      }),
    );
    const verification = verifyProtectionReceipt(dir);
    expect(verification.problems).toEqual([]);
    expect(verification.receipt?.schema).toBe(3);
  });

  it("is no signal for a receipt on a schema older than the first, or not a number", () => {
    const dir = join(root, "dist");
    mkdirSync(dir, { recursive: true });
    const a = join(dir, "a.js");
    writeFileSync(a, "export const a = 1;");
    for (const schema of [0, "1", 1.5, null]) {
      writeFileSync(
        join(dir, PROTECTION_RECEIPT_FILE),
        JSON.stringify({
          schema,
          files: [{ path: "a.js", sha256: sha256Of(a), transformed: true }],
        }),
      );
      expect(detectAlreadyObfuscatedInputs([a], dir)).toBeNull();
    }
  });

  it("finds a match when the receipt sits exactly at startDir", () => {
    const dir = join(root, "dist");
    mkdirSync(dir, { recursive: true });
    const a = join(dir, "a.js");
    writeFileSync(a, "OBF:export const a = 1;");
    receiptAt(dir, [a]);

    const result = detectAlreadyObfuscatedInputs([a], dir);
    expect(result?.files).toEqual([a]);
    expect(result?.receiptPath).toBe(join(dir, PROTECTION_RECEIPT_FILE));
  });

  it("finds a match when the receipt lives in an ANCESTOR of startDir", () => {
    const dir = join(root, "dist", "chunks");
    mkdirSync(dir, { recursive: true });
    const a = join(dir, "a.js");
    writeFileSync(a, "OBF:export const a = 1;");
    receiptAt(root, [a]);

    const result = detectAlreadyObfuscatedInputs([a], dir);
    expect(result?.files).toEqual([a]);
    expect(result?.receiptPath).toBe(join(root, PROTECTION_RECEIPT_FILE));
  });

  it("returns null when the receipt exists but no current file's hash matches", () => {
    const dir = join(root, "dist");
    mkdirSync(dir, { recursive: true });
    const a = join(dir, "a.js");
    writeFileSync(a, "export const a = 1;");
    receiptAt(dir, [a]);
    writeFileSync(a, "export const a = 2;");
    expect(detectAlreadyObfuscatedInputs([a], dir)).toBeNull();
  });

  it("matches by content hash alone — a renamed/moved file with unchanged bytes still counts", () => {
    const dir = join(root, "dist");
    mkdirSync(dir, { recursive: true });
    const original = join(dir, "old-name.js");
    writeFileSync(original, "OBF:export const a = 1;");
    receiptAt(dir, [original]);

    const moved = join(dir, "new-name.js");
    writeFileSync(moved, "OBF:export const a = 1;");
    const result = detectAlreadyObfuscatedInputs([moved], dir);
    expect(result?.files).toEqual([moved]);
  });

  it("only reports the subset of files that actually match", () => {
    const dir = join(root, "dist");
    mkdirSync(dir, { recursive: true });
    const stale = join(dir, "stale.js");
    const fresh = join(dir, "fresh.js");
    writeFileSync(stale, "OBF:stale");
    writeFileSync(fresh, "export const fresh = 1;");
    receiptAt(dir, [stale]);

    const result = detectAlreadyObfuscatedInputs([stale, fresh], dir);
    expect(result?.files).toEqual([stale]);
  });

  it("skips a listed file that no longer exists on disk, without throwing", () => {
    const dir = join(root, "dist");
    mkdirSync(dir, { recursive: true });
    const a = join(dir, "a.js");
    writeFileSync(a, "OBF:export const a = 1;");
    receiptAt(dir, [a]);

    const missing = join(dir, "gone.js");
    expect(() => detectAlreadyObfuscatedInputs([missing], dir)).not.toThrow();
    expect(detectAlreadyObfuscatedInputs([missing], dir)).toBeNull();
  });

  it("hashes the bytes the caller already read instead of re-reading the file", () => {
    const dir = join(root, "dist");
    mkdirSync(dir, { recursive: true });
    const a = join(dir, "a.js");
    writeFileSync(a, "OBF:export const a = 1;");
    receiptAt(dir, [a]);
    const obfuscated = readFileSync(a);

    writeFileSync(a, "something else entirely");
    expect(detectAlreadyObfuscatedInputs([a], dir)).toBeNull();
    expect(detectAlreadyObfuscatedInputs([a], dir, new Map([[a, obfuscated]]))?.files).toEqual([a]);
  });

  it("ignores a receipt whose files array is empty", () => {
    const dir = join(root, "dist");
    mkdirSync(dir, { recursive: true });
    const a = join(dir, "a.js");
    writeFileSync(a, "OBF:export const a = 1;");
    receiptAt(dir, []);
    expect(detectAlreadyObfuscatedInputs([a], dir)).toBeNull();
  });
});
