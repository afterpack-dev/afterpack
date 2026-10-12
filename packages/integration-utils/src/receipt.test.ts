import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { afterpackHome } from "./home.js";
import {
  detectAlreadyObfuscatedInputs,
  prepareProtectionReceipt,
  protectionReceiptPath,
  sha256Of,
  sweepOutputTree,
  UnreadableReceiptError,
  verifyProtectionReceipt,
  writeProtectionReceipt,
} from "./receipt.js";

let root: string;

function receiptsDir(): string {
  return join(root, ".afterpack", "receipts");
}

function writeRawReceipt(dir: string, content: string): void {
  mkdirSync(receiptsDir(), { recursive: true });
  writeFileSync(protectionReceiptPath(dir), content);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "afterpack-receipt-test-")));
  writeFileSync(join(root, "package.json"), "{}");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function receiptAt(dir: string, files: string[], transformed: string[] = files): string {
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
    transformed,
  });
}

function distWith(name: string, content: string, sub = "dist"): { dir: string; file: string } {
  const dir = join(root, sub);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, content);
  return { dir, file };
}

describe("detectAlreadyObfuscatedInputs", () => {
  it("returns null when the project holds no receipt", () => {
    const { dir, file } = distWith("a.js", "export const a = 1;");
    expect(detectAlreadyObfuscatedInputs([file], dir)).toBeNull();
  });

  it("is no signal for a malformed (non-JSON) receipt", () => {
    const { dir, file } = distWith("a.js", "export const a = 1;");
    writeRawReceipt(dir, "not json");
    expect(detectAlreadyObfuscatedInputs([file], dir)).toBeNull();
  });

  it("reads the fields it knows from a newer receipt schema, so the guard still fires", () => {
    const { dir, file } = distWith("a.js", "export const a = 1;");
    writeRawReceipt(
      dir,
      JSON.stringify({
        schema: 99,
        futureField: { anything: true },
        files: [{ path: "a.js", sha256: sha256Of(file), transformed: true, extra: 1 }],
      }),
    );
    expect(detectAlreadyObfuscatedInputs([file], dir)?.files).toEqual([file]);
  });

  it("refuses loudly on a newer schema whose files it cannot read, never treating them as unprotected", () => {
    const { dir, file } = distWith("a.js", "export const a = 1;");
    writeRawReceipt(dir, JSON.stringify({ schema: 2, outputs: { "a.js": sha256Of(file) } }));
    expect(() => detectAlreadyObfuscatedInputs([file], dir)).toThrow(UnreadableReceiptError);
    expect(() => detectAlreadyObfuscatedInputs([file], dir)).toThrow(/receipt schema 2/);
  });

  it("verifies a newer-schema receipt by the fields it knows", () => {
    const { dir, file } = distWith("a.js", "OBF");
    writeRawReceipt(
      dir,
      JSON.stringify({
        schema: 3,
        buildId: null,
        files: [{ path: "a.js", sha256: sha256Of(file), transformed: true }],
      }),
    );
    const verification = verifyProtectionReceipt(protectionReceiptPath(dir), dir);
    expect(verification.problems).toEqual([]);
    expect(verification.receipt?.schema).toBe(3);
  });

  it("is no signal for a receipt on a schema older than the first, or not a number", () => {
    const { dir, file } = distWith("a.js", "export const a = 1;");
    for (const schema of [0, "1", 1.5, null]) {
      writeRawReceipt(
        dir,
        JSON.stringify({
          schema,
          files: [{ path: "a.js", sha256: sha256Of(file), transformed: true }],
        }),
      );
      expect(detectAlreadyObfuscatedInputs([file], dir)).toBeNull();
    }
  });

  it("finds a match in the receipt of the dir itself", () => {
    const { dir, file } = distWith("a.js", "OBF:export const a = 1;");
    receiptAt(dir, [file]);

    const result = detectAlreadyObfuscatedInputs([file], dir);
    expect(result?.files).toEqual([file]);
    expect(result?.receiptPath).toBe(join(receiptsDir(), "dist.json"));
  });

  it("finds a match in the receipt of an ANCESTOR dir", () => {
    const { file } = distWith("a.js", "OBF:export const a = 1;", join("dist", "chunks"));
    receiptAt(join(root, "dist"), [file]);

    const result = detectAlreadyObfuscatedInputs([file], join(root, "dist", "chunks"));
    expect(result?.files).toEqual([file]);
    expect(result?.receiptPath).toBe(join(receiptsDir(), "dist.json"));
  });

  it("finds a match in the receipt of a DESCENDANT dir: dist/browser, then dist", () => {
    const { dir, file } = distWith("main.js", "OBF:main", join("dist", "browser"));
    receiptAt(dir, [file]);

    const result = detectAlreadyObfuscatedInputs([file], join(root, "dist"));
    expect(result?.files).toEqual([file]);
    expect(result?.receiptPath).toBe(join(receiptsDir(), "dist%2Fbrowser.json"));
  });

  it("reads every receipt that covers the dir, not just one", () => {
    const outer = distWith("x.js", "OBF:x");
    receiptAt(outer.dir, [outer.file]);
    const inner = distWith("y.js", "OBF:y", join("dist", "inner"));
    receiptAt(inner.dir, [inner.file]);

    expect(detectAlreadyObfuscatedInputs([inner.file], join(root, "dist"))?.files).toEqual([
      inner.file,
    ]);
  });

  it("ignores another build dir's receipt in the same project", () => {
    const { dir, file } = distWith("a.js", "OBF:export const a = 1;", join("dist", "client"));
    mkdirSync(join(root, "dist", "server"), { recursive: true });
    receiptAt(join(root, "dist", "server"), [file]);
    expect(detectAlreadyObfuscatedInputs([file], dir)).toBeNull();
  });

  it("returns null when the receipt exists but no current file's hash matches", () => {
    const { dir, file } = distWith("a.js", "export const a = 1;");
    receiptAt(dir, [file]);
    writeFileSync(file, "export const a = 2;");
    expect(detectAlreadyObfuscatedInputs([file], dir)).toBeNull();
  });

  it("matches by content hash alone — a renamed/moved file with unchanged bytes still counts", () => {
    const { dir, file } = distWith("old-name.js", "OBF:export const a = 1;");
    receiptAt(dir, [file]);

    const moved = join(dir, "new-name.js");
    writeFileSync(moved, "OBF:export const a = 1;");
    expect(detectAlreadyObfuscatedInputs([moved], dir)?.files).toEqual([moved]);
  });

  it("only reports the subset of files that actually match", () => {
    const { dir, file: stale } = distWith("stale.js", "OBF:stale");
    const fresh = join(dir, "fresh.js");
    writeFileSync(fresh, "export const fresh = 1;");
    receiptAt(dir, [stale]);

    expect(detectAlreadyObfuscatedInputs([stale, fresh], dir)?.files).toEqual([stale]);
  });

  it("skips a listed file that no longer exists on disk, without throwing", () => {
    const { dir, file } = distWith("a.js", "OBF:export const a = 1;");
    receiptAt(dir, [file]);

    const missing = join(dir, "gone.js");
    expect(() => detectAlreadyObfuscatedInputs([missing], dir)).not.toThrow();
    expect(detectAlreadyObfuscatedInputs([missing], dir)).toBeNull();
  });

  it("hashes the bytes the caller already read instead of re-reading the file", () => {
    const { dir, file } = distWith("a.js", "OBF:export const a = 1;");
    receiptAt(dir, [file]);
    const obfuscated = readFileSync(file);

    writeFileSync(file, "something else entirely");
    expect(detectAlreadyObfuscatedInputs([file], dir)).toBeNull();
    expect(
      detectAlreadyObfuscatedInputs([file], dir, new Map([[file, obfuscated]]))?.files,
    ).toEqual([file]);
  });

  it("ignores a receipt whose files array is empty", () => {
    const { dir, file } = distWith("a.js", "OBF:export const a = 1;");
    receiptAt(dir, []);
    expect(detectAlreadyObfuscatedInputs([file], dir)).toBeNull();
  });

  it("is no signal for a file the receipt records as unchanged — a rebuild reproduces those bytes", () => {
    const { dir, file } = distWith("empty.js", "export {};");
    receiptAt(dir, [file], []);
    expect(detectAlreadyObfuscatedInputs([file], dir)).toBeNull();
  });
});

describe("where a protection receipt lives", () => {
  it("is .afterpack/receipts/ beside the project marker, never the build dir", () => {
    const { dir, file } = distWith("a.js", "OBF");
    const path = receiptAt(dir, [file]);
    expect(path).toBe(join(receiptsDir(), "dist.json"));
    expect(readdirSync(dir)).toEqual(["a.js"]);
    expect(readFileSync(join(root, ".afterpack", ".gitignore"), "utf8")).toBe("*\n");
    expect(JSON.parse(readFileSync(path, "utf8")).buildDir).toBe("dist");
  });

  it("names each build dir by its path from the project root, so builds never collide", () => {
    for (const sub of ["dist", join("dist", "browser"), ".next"]) {
      mkdirSync(join(root, sub), { recursive: true });
    }
    expect(protectionReceiptPath(join(root, "dist"))).toBe(join(receiptsDir(), "dist.json"));
    expect(protectionReceiptPath(join(root, "dist", "browser"))).toBe(
      join(receiptsDir(), "dist%2Fbrowser.json"),
    );
    expect(protectionReceiptPath(join(root, ".next"))).toBe(join(receiptsDir(), ".next.json"));
    expect(protectionReceiptPath(join(root, "a*b"))).toBe(join(receiptsDir(), "a%2Ab.json"));
  });

  it("gives one key to case-different spellings of the same dir on a case-insensitive disk", () => {
    mkdirSync(join(root, "dist"));
    if (!existsSync(join(root, "DIST"))) return;
    expect(protectionReceiptPath(join(root, "DIST"))).toBe(
      protectionReceiptPath(join(root, "dist")),
    );
    expect(protectionReceiptPath(join(root, "Dist"))).toBe(join(receiptsDir(), "dist.json"));
  });

  it("encodes ~ so a real dir name can never equal a hashed key", () => {
    const dir = join(root, "a~b");
    mkdirSync(dir);
    expect(basename(protectionReceiptPath(dir))).toBe("a%7Eb.json");
  });

  it("gives two workspace packages of one lockfile root distinct keys in one receipts dir", () => {
    writeFileSync(join(root, "pnpm-lock.yaml"), "");
    const a = distWith("index.js", "OBF:a", join("packages", "a", "dist"));
    const b = distWith("index.js", "OBF:b", join("packages", "b", "dist"));
    writeFileSync(join(root, "packages", "a", "package.json"), "{}");
    writeFileSync(join(root, "packages", "b", "package.json"), "{}");
    receiptAt(a.dir, [a.file]);
    receiptAt(b.dir, [b.file]);

    expect(readdirSync(receiptsDir()).sort()).toEqual([
      "packages%2Fa%2Fdist.json",
      "packages%2Fb%2Fdist.json",
    ]);
    expect(detectAlreadyObfuscatedInputs([a.file], a.dir)?.files).toEqual([a.file]);
    expect(detectAlreadyObfuscatedInputs([b.file], a.dir)).toBeNull();
  });

  it("keeps a short CJK key readable", () => {
    const dir = join(root, "构建");
    mkdirSync(dir);
    expect(basename(protectionReceiptPath(dir))).toBe(`${encodeURIComponent("构建")}.json`);
  });

  it("hashes a key past 180 bytes behind a readable prefix, and keeps long keys distinct", () => {
    const deep = join(root, ...Array.from({ length: 12 }, (_, i) => `segment-number-${i}`));
    const cjk = join(root, "输出目录".repeat(8));
    mkdirSync(join(deep, "a"), { recursive: true });
    mkdirSync(join(deep, "b"), { recursive: true });
    mkdirSync(cjk);

    const a = basename(protectionReceiptPath(join(deep, "a")), ".json");
    const b = basename(protectionReceiptPath(join(deep, "b")), ".json");
    const c = basename(protectionReceiptPath(cjk), ".json");
    for (const key of [a, b, c]) {
      expect(Buffer.byteLength(key)).toBeLessThanOrEqual(180);
      expect(key).toMatch(/~[0-9a-f]{16}$/);
    }
    expect(a.startsWith("segment-number-0%2Fsegment-number-1")).toBe(true);
    expect(c).toMatch(/^(%[0-9A-F]{2})+~[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
  });

  it("writes and verifies a receipt under a long key", () => {
    const deep = join(root, ...Array.from({ length: 12 }, (_, i) => `segment-number-${i}`));
    mkdirSync(deep, { recursive: true });
    const file = join(deep, "a.js");
    writeFileSync(file, "OBF");
    const path = receiptAt(deep, [file]);
    expect(dirname(path)).toBe(receiptsDir());
    expect(verifyProtectionReceipt(protectionReceiptPath(deep), deep).problems).toEqual([]);
  });
});

describe("prepareProtectionReceipt", () => {
  it("creates the receipts dir and leaves no receipt behind", () => {
    const { dir } = distWith("a.js", "x");
    const path = prepareProtectionReceipt(dir, "afterpack-test");
    expect(existsSync(receiptsDir())).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it("keeps an existing receipt as it was", () => {
    const { dir, file } = distWith("a.js", "OBF");
    const path = receiptAt(dir, [file]);
    const before = readFileSync(path, "utf8");
    prepareProtectionReceipt(dir, "afterpack-test");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("fails, naming the path, when the receipt cannot be written", () => {
    const { dir } = distWith("a.js", "x");
    mkdirSync(join(root, ".afterpack"), { recursive: true });
    writeFileSync(receiptsDir(), "a file where the receipts dir belongs");
    expect(() => prepareProtectionReceipt(dir, "afterpack-test")).toThrow(
      /\[afterpack-test\] cannot write the protection receipt .*dist\.json, so no file was rewritten/,
    );
  });
});

describe("sweepOutputTree", () => {
  it("refuses a stale .afterpack/ inside a nested project of the output", () => {
    const dir = join(root, "dist");
    mkdirSync(join(dir, "cjs", ".afterpack", "backup"), { recursive: true });
    writeFileSync(join(dir, "cjs", "package.json"), "{}");
    expect(() => sweepOutputTree(dir, dir, "afterpack-test")).toThrow(
      /found .*cjs\/\.afterpack inside the build output/,
    );
  });

  it("still skips node_modules", () => {
    const dir = join(root, "dist");
    mkdirSync(join(dir, "node_modules", "x", ".afterpack"), { recursive: true });
    expect(() => sweepOutputTree(dir, dir, "afterpack-test")).not.toThrow();
  });

  it("spares the run's own home only when it sits at a strong marker", () => {
    writeFileSync(join(root, "package-lock.json"), "{}");
    mkdirSync(join(root, ".afterpack"), { recursive: true });
    const strong = afterpackHome(root, { fileTarget: true });
    expect(() => sweepOutputTree(root, null, "afterpack-test", strong)).not.toThrow();

    const weak = { ...strong, strong: false };
    expect(() => sweepOutputTree(root, null, "afterpack-test", weak)).toThrow(
      /inside the build output/,
    );
  });

  it("removes stale receipts throughout the tree it walks", () => {
    const { dir } = distWith(".afterpack-protection.json", "{}");
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "assets", ".afterpack-protection.json"), "{}");

    sweepOutputTree(dir, dir, "afterpack-test");

    expect(readdirSync(dir)).toEqual(["assets"]);
    expect(readdirSync(join(dir, "assets"))).toEqual([]);
  });

  it("looks only at the top level when it walks no tree", () => {
    const { dir } = distWith(".afterpack-protection.json", "{}");
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "assets", ".afterpack-protection.json"), "{}");

    sweepOutputTree(dir, null, "afterpack-test");

    expect(readdirSync(dir)).toEqual(["assets"]);
    expect(readdirSync(join(dir, "assets"))).toEqual([".afterpack-protection.json"]);
  });

  it("is a no-op when there is no build dir yet", () => {
    expect(() => sweepOutputTree(join(root, "missing"), null, "afterpack-test")).not.toThrow();
  });

  it("fails loudly when a stale receipt cannot be removed", () => {
    const dir = join(root, "dist");
    mkdirSync(join(dir, ".afterpack-protection.json"), { recursive: true });
    expect(() => sweepOutputTree(dir, dir, "afterpack-test")).toThrow(
      /\[afterpack-test\] could not remove the stale protection receipt/,
    );
  });

  it("fails the run on a .afterpack/ dir inside the build output, naming it", () => {
    const dir = join(root, "public");
    mkdirSync(join(dir, "nested", ".afterpack", "backup"), { recursive: true });
    expect(() => sweepOutputTree(dir, dir, "afterpack-test")).toThrow(
      new RegExp(
        `\\[afterpack-test\\] found ${join(dir, "nested", ".afterpack").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} inside the build output .*Delete .*\\.afterpack, then build again`,
      ),
    );
  });
});
