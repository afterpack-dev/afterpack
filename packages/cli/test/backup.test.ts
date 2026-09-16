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
  backupDir,
  backupManifestPath,
  captureOriginals,
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
    });

    const manifest = readBackupManifest(root);
    expect(manifest).toMatchObject({
      schema: 1,
      protectedRoot: join(root, "dist"),
      cliVersion: "9.9.9",
      files: [
        {
          path: "dist/app.js",
          originalSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          obfuscatedSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      ],
    });
    expect(manifest?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(manifest?.files[0].originalSha256).not.toBe(manifest?.files[0].obfuscatedSha256);
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
    });

    expect(existsSync(join(backupDir(root), "dist", "app.js"))).toBe(false);
    expect(existsSync(join(backupDir(root), "dist", "b.js"))).toBe(true);
    expect(readBackupManifest(root)?.files).toHaveLength(1);
  });
});

describe("readBackupManifest", () => {
  it("returns null when there is no manifest", () => {
    expect(readBackupManifest(root)).toBeNull();
  });

  it("returns null on a malformed manifest rather than throwing", () => {
    mkdirSync(backupDir(root), { recursive: true });
    writeFileSync(backupManifestPath(root), "not json");
    expect(readBackupManifest(root)).toBeNull();
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
    });

    const current = captureOriginals(root, [file]);
    expect(matchAlreadyObfuscated(readBackupManifest(root) as never, current)).toEqual([file]);
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
    });

    writeFileSync(file, "export const a = 1;");
    const current = captureOriginals(root, [file]);
    expect(matchAlreadyObfuscated(readBackupManifest(root) as never, current)).toEqual([]);
  });
});
