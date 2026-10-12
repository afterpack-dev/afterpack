import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectAlreadyObfuscatedInputs,
  findProtectionReceipt,
  protectionReceiptPath,
  removeStaleOutputReceipt,
  sha256Of,
  UnreadableReceiptError,
  verifyProtectionReceipt,
  writeProtectionReceipt,
} from "./receipt.js";

let root: string;
let afterpackDir: string;

function receiptFor(dir: string): string {
  return protectionReceiptPath(afterpackDir, dir);
}

function writeRawReceipt(dir: string, content: string): void {
  const path = receiptFor(dir);
  mkdirSync(join(afterpackDir, "receipts"), { recursive: true });
  writeFileSync(path, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "afterpack-receipt-test-"));
  afterpackDir = join(root, ".afterpack");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function receiptAt(dir: string, files: string[], transformed: string[] = files): string {
  return writeProtectionReceipt({
    dir,
    afterpackDir,
    tool: "afterpack-test",
    engine: "local",
    engineVersion: null,
    seed: 1,
    seedOrigin: "fresh",
    bundler: "test",
    buildId: null,
    files,
    transformed,
  });
}

describe("detectAlreadyObfuscatedInputs", () => {
  it("returns null when no receipt exists anywhere at/above startDir", () => {
    const dir = join(root, "dist");
    mkdirSync(dir, { recursive: true });
    const a = join(dir, "a.js");
    writeFileSync(a, "export const a = 1;");
    expect(detectAlreadyObfuscatedInputs([a], dir, afterpackDir)).toBeNull();
  });

  it("is no signal for a malformed (non-JSON) receipt", () => {
    const dir = join(root, "dist");
    mkdirSync(dir, { recursive: true });
    const a = join(dir, "a.js");
    writeFileSync(a, "export const a = 1;");
    writeRawReceipt(dir, "not json");
    expect(detectAlreadyObfuscatedInputs([a], dir, afterpackDir)).toBeNull();
  });

  it("reads the fields it knows from a newer receipt schema, so the guard still fires", () => {
    const dir = join(root, "dist");
    mkdirSync(dir, { recursive: true });
    const a = join(dir, "a.js");
    writeFileSync(a, "export const a = 1;");
    writeRawReceipt(
      dir,
      JSON.stringify({
        schema: 99,
        futureField: { anything: true },
        files: [{ path: "a.js", sha256: sha256Of(a), transformed: true, extra: 1 }],
      }),
    );
    expect(detectAlreadyObfuscatedInputs([a], dir, afterpackDir)?.files).toEqual([a]);
  });

  it("refuses loudly on a newer schema whose files it cannot read, never treating them as unprotected", () => {
    const dir = join(root, "dist");
    mkdirSync(dir, { recursive: true });
    const a = join(dir, "a.js");
    writeFileSync(a, "export const a = 1;");
    writeRawReceipt(dir, JSON.stringify({ schema: 2, outputs: { "a.js": sha256Of(a) } }));
    expect(() => detectAlreadyObfuscatedInputs([a], dir, afterpackDir)).toThrow(
      UnreadableReceiptError,
    );
    expect(() => detectAlreadyObfuscatedInputs([a], dir, afterpackDir)).toThrow(/receipt schema 2/);
  });

  it("verifies a newer-schema receipt by the fields it knows", () => {
    const dir = join(root, "dist");
    mkdirSync(dir, { recursive: true });
    const a = join(dir, "a.js");
    writeFileSync(a, "OBF");
    writeRawReceipt(
      dir,
      JSON.stringify({
        schema: 3,
        buildId: null,
        files: [{ path: "a.js", sha256: sha256Of(a), transformed: true }],
      }),
    );
    const verification = verifyProtectionReceipt(receiptFor(dir), dir);
    expect(verification.problems).toEqual([]);
    expect(verification.receipt?.schema).toBe(3);
  });

  it("is no signal for a receipt on a schema older than the first, or not a number", () => {
    const dir = join(root, "dist");
    mkdirSync(dir, { recursive: true });
    const a = join(dir, "a.js");
    writeFileSync(a, "export const a = 1;");
    for (const schema of [0, "1", 1.5, null]) {
      writeRawReceipt(
        dir,
        JSON.stringify({
          schema,
          files: [{ path: "a.js", sha256: sha256Of(a), transformed: true }],
        }),
      );
      expect(detectAlreadyObfuscatedInputs([a], dir, afterpackDir)).toBeNull();
    }
  });

  it("finds a match when the receipt sits exactly at startDir", () => {
    const dir = join(root, "dist");
    mkdirSync(dir, { recursive: true });
    const a = join(dir, "a.js");
    writeFileSync(a, "OBF:export const a = 1;");
    receiptAt(dir, [a]);

    const result = detectAlreadyObfuscatedInputs([a], dir, afterpackDir);
    expect(result?.files).toEqual([a]);
    expect(result?.receiptPath).toBe(join(afterpackDir, "receipts", "dist.json"));
  });

  it("finds a match when the receipt lives in an ANCESTOR of startDir", () => {
    const dir = join(root, "dist", "chunks");
    mkdirSync(dir, { recursive: true });
    const a = join(dir, "a.js");
    writeFileSync(a, "OBF:export const a = 1;");
    receiptAt(root, [a]);

    const result = detectAlreadyObfuscatedInputs([a], dir, afterpackDir);
    expect(result?.files).toEqual([a]);
    expect(result?.receiptPath).toBe(join(afterpackDir, "receipts", "..json"));
  });

  it("returns null when the receipt exists but no current file's hash matches", () => {
    const dir = join(root, "dist");
    mkdirSync(dir, { recursive: true });
    const a = join(dir, "a.js");
    writeFileSync(a, "export const a = 1;");
    receiptAt(dir, [a]);
    writeFileSync(a, "export const a = 2;");
    expect(detectAlreadyObfuscatedInputs([a], dir, afterpackDir)).toBeNull();
  });

  it("matches by content hash alone — a renamed/moved file with unchanged bytes still counts", () => {
    const dir = join(root, "dist");
    mkdirSync(dir, { recursive: true });
    const original = join(dir, "old-name.js");
    writeFileSync(original, "OBF:export const a = 1;");
    receiptAt(dir, [original]);

    const moved = join(dir, "new-name.js");
    writeFileSync(moved, "OBF:export const a = 1;");
    const result = detectAlreadyObfuscatedInputs([moved], dir, afterpackDir);
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

    const result = detectAlreadyObfuscatedInputs([stale, fresh], dir, afterpackDir);
    expect(result?.files).toEqual([stale]);
  });

  it("skips a listed file that no longer exists on disk, without throwing", () => {
    const dir = join(root, "dist");
    mkdirSync(dir, { recursive: true });
    const a = join(dir, "a.js");
    writeFileSync(a, "OBF:export const a = 1;");
    receiptAt(dir, [a]);

    const missing = join(dir, "gone.js");
    expect(() => detectAlreadyObfuscatedInputs([missing], dir, afterpackDir)).not.toThrow();
    expect(detectAlreadyObfuscatedInputs([missing], dir, afterpackDir)).toBeNull();
  });

  it("hashes the bytes the caller already read instead of re-reading the file", () => {
    const dir = join(root, "dist");
    mkdirSync(dir, { recursive: true });
    const a = join(dir, "a.js");
    writeFileSync(a, "OBF:export const a = 1;");
    receiptAt(dir, [a]);
    const obfuscated = readFileSync(a);

    writeFileSync(a, "something else entirely");
    expect(detectAlreadyObfuscatedInputs([a], dir, afterpackDir)).toBeNull();
    expect(
      detectAlreadyObfuscatedInputs([a], dir, afterpackDir, new Map([[a, obfuscated]]))?.files,
    ).toEqual([a]);
  });

  it("ignores a receipt whose files array is empty", () => {
    const dir = join(root, "dist");
    mkdirSync(dir, { recursive: true });
    const a = join(dir, "a.js");
    writeFileSync(a, "OBF:export const a = 1;");
    receiptAt(dir, []);
    expect(detectAlreadyObfuscatedInputs([a], dir, afterpackDir)).toBeNull();
  });

  it("is no signal for a file the receipt records as unchanged — a rebuild reproduces those bytes", () => {
    const dir = join(root, "dist");
    mkdirSync(dir, { recursive: true });
    const untouched = join(dir, "empty.js");
    writeFileSync(untouched, "export {};");
    receiptAt(dir, [untouched], []);
    expect(detectAlreadyObfuscatedInputs([untouched], dir, afterpackDir)).toBeNull();
  });

  it("ignores another build dir's receipt in the same project", () => {
    const dir = join(root, "dist", "client");
    const other = join(root, "dist", "server");
    mkdirSync(dir, { recursive: true });
    mkdirSync(other, { recursive: true });
    const a = join(dir, "a.js");
    writeFileSync(a, "OBF:export const a = 1;");
    receiptAt(other, [a]);
    expect(detectAlreadyObfuscatedInputs([a], dir, afterpackDir)).toBeNull();
  });
});

describe("where a protection receipt lives", () => {
  it("is the project's .afterpack/receipts/, never the build dir", () => {
    const dir = join(root, "dist");
    mkdirSync(dir, { recursive: true });
    const a = join(dir, "a.js");
    writeFileSync(a, "OBF");
    const path = receiptAt(dir, [a]);
    expect(path).toBe(join(root, ".afterpack", "receipts", "dist.json"));
    expect(readdirSync(dir)).toEqual(["a.js"]);
    expect(readFileSync(join(root, ".afterpack", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("names each build dir by its path from the project root, so builds never collide", () => {
    expect(receiptFor(join(root, "dist"))).toBe(join(afterpackDir, "receipts", "dist.json"));
    expect(receiptFor(join(root, "dist", "browser"))).toBe(
      join(afterpackDir, "receipts", "dist%2Fbrowser.json"),
    );
    expect(receiptFor(join(root, ".next"))).toBe(join(afterpackDir, "receipts", ".next.json"));
    expect(receiptFor(root)).toBe(join(afterpackDir, "receipts", "..json"));
    expect(receiptFor(join(root, "..", "elsewhere", "out"))).toBe(
      join(afterpackDir, "receipts", "..%2Felsewhere%2Fout.json"),
    );
    expect(receiptFor(join(root, "a*b"))).toBe(join(afterpackDir, "receipts", "a%2Ab.json"));
  });

  it("keys a nested .afterpack leg dir by the project root, at one receipts dir", () => {
    expect(protectionReceiptPath(join(afterpackDir, "client"), join(root, "dist", "client"))).toBe(
      join(afterpackDir, "receipts", "dist%2Fclient.json"),
    );
  });

  it("resolves the same key through a symlinked project path", () => {
    const real = join(root, "real");
    mkdirSync(join(real, "dist"), { recursive: true });
    const link = join(root, "link");
    symlinkSync(real, link);
    expect(protectionReceiptPath(join(link, ".afterpack"), join(real, "dist"))).toBe(
      join(link, ".afterpack", "receipts", "dist.json"),
    );
  });
});

describe("findProtectionReceipt", () => {
  it("finds the receipt of a build dir from the .afterpack/ above it", () => {
    const dir = join(root, "dist", "browser");
    mkdirSync(dir, { recursive: true });
    const a = join(dir, "a.js");
    writeFileSync(a, "OBF");
    const written = receiptAt(dir, [a]);
    expect(findProtectionReceipt(dir)).toBe(written);
  });

  it("finds a receipt for a build dir outside the project through the roots it is given", () => {
    const project = join(root, "project");
    const out = join(root, "out");
    mkdirSync(project, { recursive: true });
    mkdirSync(out, { recursive: true });
    const a = join(out, "a.js");
    writeFileSync(a, "OBF");
    const written = writeProtectionReceipt({
      dir: out,
      afterpackDir: join(project, ".afterpack"),
      tool: "afterpack-test",
      engine: "local",
      engineVersion: null,
      seed: 1,
      seedOrigin: "fresh",
      bundler: "test",
      buildId: null,
      files: [a],
      transformed: [a],
    });
    expect(findProtectionReceipt(out)).toBeNull();
    expect(findProtectionReceipt(out, [project])).toBe(written);
  });

  it("is null when no .afterpack/ at or above the dir holds a receipt for it", () => {
    const dir = join(root, "dist");
    const other = join(root, "other");
    mkdirSync(dir, { recursive: true });
    mkdirSync(other, { recursive: true });
    const a = join(other, "a.js");
    writeFileSync(a, "OBF");
    receiptAt(other, [a]);
    expect(findProtectionReceipt(dir)).toBeNull();
  });
});

describe("removeStaleOutputReceipt", () => {
  it("removes a receipt an earlier run wrote into the build dir", () => {
    const dir = join(root, "dist");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".afterpack-protection.json"), "{}");
    removeStaleOutputReceipt(dir, "afterpack-test");
    expect(existsSync(join(dir, ".afterpack-protection.json"))).toBe(false);
  });

  it("is a no-op when there is none, or no build dir yet", () => {
    expect(() => removeStaleOutputReceipt(join(root, "missing"), "afterpack-test")).not.toThrow();
  });

  it("fails loudly when the stale receipt cannot be removed", () => {
    const dir = join(root, "dist");
    mkdirSync(join(dir, ".afterpack-protection.json"), { recursive: true });
    expect(() => removeStaleOutputReceipt(dir, "afterpack-test")).toThrow(
      /\[afterpack-test\] could not remove the stale protection receipt/,
    );
  });
});
