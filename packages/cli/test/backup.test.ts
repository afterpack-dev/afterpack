import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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
  captureOriginals,
  findBackupProjectRoot,
  matchAlreadyObfuscated,
  readBackupManifest,
  writeBackups,
} from "../src/backup.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "afterpack-backup-"));
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

function okManifest(projectRoot: string): BackupManifest {
  const result = readBackupManifest(projectRoot);
  if (result.status !== "ok") throw new Error(`expected an ok manifest, got ${result.status}`);
  return result.manifest;
}

describe("writeBackups", () => {
  it("writes the manifest and mirrors every file under .afterpack/backup/, never beside it", () => {
    const file = distApp();
    const pending = captureOriginals(root, [file]);
    writeFileSync(file, "OBF:export const a = 1;");

    const { manifestPath, count } = writeBackups({
      projectRoot: root,
      protectedRoot: join(root, "dist"),
      cliVersion: "9.9.9",
      pending,
      receiptPath: null,
    });

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
    const pending = captureOriginals(root, [file]);
    writeFileSync(file, "OBF:export const a = 1;");

    writeBackups({
      projectRoot: root,
      protectedRoot: join(root, "dist"),
      cliVersion: "9.9.9",
      pending,
      receiptPath: join(root, "dist", ".afterpack-protection.json"),
    });

    const manifest = okManifest(root);
    expect(manifest).toMatchObject({
      schema: 1,
      protectedRoot: join(root, "dist"),
      cliVersion: "9.9.9",
      receiptPath: join(root, "dist", ".afterpack-protection.json"),
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
    let pending = captureOriginals(root, [file]);
    writeFileSync(file, "OBF:export const a = 1;");
    writeBackups({
      projectRoot: root,
      protectedRoot: join(root, "dist"),
      cliVersion: "9.9.9",
      pending,
      receiptPath: null,
    });

    const other = join(root, "dist", "b.js");
    writeFileSync(other, "export const b = 2;");
    pending = captureOriginals(root, [other]);
    writeFileSync(other, "OBF:export const b = 2;");
    writeBackups({
      projectRoot: root,
      protectedRoot: join(root, "dist"),
      cliVersion: "9.9.9",
      pending,
      receiptPath: null,
    });

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
    const pending = captureOriginals(root, [file]);
    writeBackups({
      projectRoot: root,
      protectedRoot: join(root, "dist"),
      cliVersion: "9.9.9",
      pending,
      receiptPath: null,
    });

    expect(findBackupProjectRoot(root)).toBe(root);
  });

  it("searches upward from a directory beneath the project root", () => {
    const file = distApp();
    const pending = captureOriginals(root, [file]);
    writeBackups({
      projectRoot: root,
      protectedRoot: join(root, "dist"),
      cliVersion: "9.9.9",
      pending,
      receiptPath: null,
    });

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
    const pending = captureOriginals(root, [file]);
    writeFileSync(file, "OBF:export const a = 1;");
    writeBackups({
      projectRoot: root,
      protectedRoot: join(root, "dist"),
      cliVersion: "9.9.9",
      pending,
      receiptPath: null,
    });

    const current = captureOriginals(root, [file]);
    expect(matchAlreadyObfuscated(okManifest(root), current)).toEqual([file]);
  });

  it("does not match once the file changes again (a fresh rebuild)", () => {
    const file = distApp();
    const pending = captureOriginals(root, [file]);
    writeFileSync(file, "OBF:export const a = 1;");
    writeBackups({
      projectRoot: root,
      protectedRoot: join(root, "dist"),
      cliVersion: "9.9.9",
      pending,
      receiptPath: null,
    });

    writeFileSync(file, "export const a = 1;");
    const current = captureOriginals(root, [file]);
    expect(matchAlreadyObfuscated(okManifest(root), current)).toEqual([]);
  });
});
