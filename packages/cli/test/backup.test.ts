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
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BackupManifest,
  backupDir,
  backupManifestPath,
  beginJournal,
  captureOriginals,
  findBackupProjectRoot,
  matchAlreadyObfuscated,
  readBackupManifest,
} from "../src/backup.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "afterpack-backup-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function distApp(): string {
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  const file = join(dist, "app.js");
  writeFileSync(file, "export const a = 1;");
  return file;
}

function protect(
  file: string,
  obfuscated: string,
  receiptPath: string | null = null,
): { manifestPath: string; count: number } {
  const journal = beginJournal({
    projectRoot: root,
    protectedRoot: join(root, "dist"),
    cliVersion: "9.9.9",
    touched: [file],
    renamed: new Map(),
    persist: true,
  });
  writeFileSync(file, obfuscated);
  const written = journal.commit(receiptPath);
  if (written === null) throw new Error("a persisted journal must commit a manifest");
  return written;
}

function okManifest(projectRoot: string): BackupManifest {
  const result = readBackupManifest(projectRoot);
  if (result.status !== "ok") throw new Error(`expected an ok manifest, got ${result.status}`);
  return result.manifest;
}

describe("the backup journal", () => {
  it("writes the manifest and mirrors every file under .afterpack/backup/, never beside it", () => {
    const file = distApp();
    const { manifestPath, count } = protect(file, "OBF:export const a = 1;");

    expect(count).toBe(1);
    expect(manifestPath).toBe(backupManifestPath(root));
    expect(existsSync(join(backupDir(root), "dist", "app.js"))).toBe(true);
    expect(readFileSync(join(backupDir(root), "dist", "app.js"), "utf8")).toBe(
      "export const a = 1;",
    );
    expect(readdirSync(join(root, "dist"))).toEqual(["app.js"]);
  });

  it("writes a manifest with the documented shape", () => {
    const file = distApp();
    protect(file, "OBF:export const a = 1;", join(root, ".afterpack", "receipts", "dist.json"));

    const manifest = okManifest(root);
    expect(manifest).toMatchObject({
      schema: 2,
      state: "complete",
      renames: [],
      protectedRoot: join(root, "dist"),
      cliVersion: "9.9.9",
      receiptPath: join(root, ".afterpack", "receipts", "dist.json"),
      files: [
        {
          path: "dist/app.js",
          originalSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          obfuscatedSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      ],
    });
    expect(manifest.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(manifest.files[0].originalSha256).not.toBe(manifest.files[0].obfuscatedSha256);
  });

  it("keeps only the most recent run — clears the previous backup", () => {
    const file = distApp();
    protect(file, "OBF:export const a = 1;");

    const other = join(root, "dist", "b.js");
    writeFileSync(other, "export const b = 2;");
    protect(other, "OBF:export const b = 2;");

    expect(existsSync(join(backupDir(root), "dist", "app.js"))).toBe(false);
    expect(existsSync(join(backupDir(root), "dist", "b.js"))).toBe(true);
    expect(okManifest(root).files).toHaveLength(1);
  });
});

describe("readBackupManifest", () => {
  it("reports `missing` when there is no manifest", () => {
    expect(readBackupManifest(root)).toEqual({ status: "missing" });
  });

  it("reports `corrupt`, distinct from `missing`, on a malformed manifest rather than throwing", () => {
    mkdirSync(backupDir(root), { recursive: true });
    writeFileSync(backupManifestPath(root), "not json");
    expect(readBackupManifest(root)).toEqual({
      status: "corrupt",
      path: backupManifestPath(root),
    });
  });

  it("reports `corrupt` on valid JSON missing the required shape", () => {
    mkdirSync(backupDir(root), { recursive: true });
    writeFileSync(backupManifestPath(root), JSON.stringify({ schema: 1 }));
    expect(readBackupManifest(root)).toEqual({
      status: "corrupt",
      path: backupManifestPath(root),
    });
  });
});

describe("findBackupProjectRoot", () => {
  it("finds the project root directly", () => {
    const file = distApp();
    protect(file, "OBF:export const a = 1;");

    expect(findBackupProjectRoot(root)).toBe(root);
  });

  it("searches upward from a directory beneath the project root", () => {
    const file = distApp();
    protect(file, "OBF:export const a = 1;");

    expect(findBackupProjectRoot(join(root, "dist"))).toBe(root);
  });

  it("returns null when nothing is found up to the filesystem root", () => {
    expect(findBackupProjectRoot(root)).toBeNull();
  });

  it("finds a manifest even when it is corrupt (existence, not validity, drives the search)", () => {
    mkdirSync(backupDir(root), { recursive: true });
    writeFileSync(backupManifestPath(root), "not json");
    mkdirSync(join(root, "dist"), { recursive: true });
    expect(findBackupProjectRoot(join(root, "dist"))).toBe(root);
  });
});

describe("matchAlreadyObfuscated", () => {
  it("matches a file whose current bytes equal the manifest's recorded obfuscated hash", () => {
    const file = distApp();
    protect(file, "OBF:export const a = 1;");

    const current = captureOriginals(root, [file]);
    expect(matchAlreadyObfuscated(okManifest(root), current)).toEqual([file]);
  });

  it("does not match once the file changes again (a fresh rebuild)", () => {
    const file = distApp();
    protect(file, "OBF:export const a = 1;");

    writeFileSync(file, "export const a = 1;");
    const current = captureOriginals(root, [file]);
    expect(matchAlreadyObfuscated(okManifest(root), current)).toEqual([]);
  });
});
