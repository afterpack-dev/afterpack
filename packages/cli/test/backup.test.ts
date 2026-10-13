import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BackupManifest,
  type BackupSlot,
  backupSlot,
  beginJournal,
  captureOriginals,
  copyPath,
  findBackupProjectRoot,
  journalCondition,
  matchAlreadyObfuscated,
  readBackupManifest,
  recoverSlot,
  slotsUnder,
} from "../src/backup.js";

let root: string;
let slot: BackupSlot;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "afterpack-backup-")));
  slot = backupSlot(root, "dist");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

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
    slot,
    protectedRoot: join(root, "dist"),
    cliVersion: "9.9.9",
    planned: new Map([[file, [sha(obfuscated)]]]),
    renamed: new Map(),
    persist: true,
  });
  writeFileSync(file, obfuscated);
  const written = journal.commit(receiptPath);
  if (written === null) throw new Error("a persisted journal must commit a manifest");
  return written;
}

function okManifest(): BackupManifest {
  const result = readBackupManifest(slot);
  if (result.status !== "ok") throw new Error(`expected an ok manifest, got ${result.status}`);
  return result.manifest;
}

describe("the backup journal", () => {
  it("keeps each build directory's backup in its own slot, never beside the output", () => {
    const file = distApp();
    const { manifestPath, count } = protect(file, "OBF:export const a = 1;");

    expect(count).toBe(1);
    expect(manifestPath).toBe(
      join(root, ".afterpack", "backups", "dist", "current", "manifest.json"),
    );
    expect(readFileSync(copyPath(slot, "dist/app.js"), "utf8")).toBe("export const a = 1;");
    expect(readdirSync(join(root, "dist"))).toEqual(["app.js"]);
  });

  it("writes a manifest with the documented shape", () => {
    const file = distApp();
    protect(file, "OBF:export const a = 1;", join(root, ".afterpack", "receipts", "dist.json"));

    const manifest = okManifest();
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
          originalSha256: sha("export const a = 1;"),
          obfuscatedSha256: sha("OBF:export const a = 1;"),
        },
      ],
    });
    expect(manifest.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("keeps only the most recent run of a directory", () => {
    const file = distApp();
    protect(file, "OBF:export const a = 1;");

    const other = join(root, "dist", "b.js");
    writeFileSync(other, "export const b = 2;");
    protect(other, "OBF:export const b = 2;");

    expect(existsSync(copyPath(slot, "dist/app.js"))).toBe(false);
    expect(existsSync(copyPath(slot, "dist/b.js"))).toBe(true);
    expect(okManifest().files).toHaveLength(1);
  });

  it("records, before the first write, the bytes it plans for each path", () => {
    const file = distApp();
    const moved = join(root, "dist", "app-2.js");
    beginJournal({
      slot,
      protectedRoot: join(root, "dist"),
      cliVersion: "9.9.9",
      planned: new Map<string, (string | null)[]>([
        [file, [null]],
        [moved, [sha("OBF")]],
      ]),
      renamed: new Map([[file, moved]]),
      persist: true,
    });
    expect(okManifest()).toMatchObject({
      state: "applying",
      files: [
        { path: "dist/app-2.js", originalSha256: null, plannedSha256: [sha("OBF")] },
        { path: "dist/app.js", originalSha256: sha("export const a = 1;"), plannedSha256: [null] },
      ],
      renames: [{ from: "dist/app.js", to: "dist/app-2.js" }],
    });
  });
});

describe("journalCondition", () => {
  function stopped(): { file: string; moved: string } {
    const file = distApp();
    const moved = join(root, "dist", "app-2.js");
    beginJournal({
      slot,
      protectedRoot: join(root, "dist"),
      cliVersion: "9.9.9",
      planned: new Map<string, (string | null)[]>([
        [file, [null]],
        [moved, [sha("OBF")]],
      ]),
      renamed: new Map([[file, moved]]),
      persist: true,
    });
    return { file, moved };
  }

  it("is pristine when the run stopped before changing anything", () => {
    stopped();
    expect(journalCondition(root, okManifest())).toBe("pristine");
  });

  it("is restorable when every file is either original or as the run planned it", () => {
    const { file, moved } = stopped();
    writeFileSync(moved, "OBF");
    rmSync(file);
    expect(journalCondition(root, okManifest())).toBe("restorable");
  });

  it("is stale when a file holds bytes the run never planned, as after a rebuild", () => {
    const { file } = stopped();
    writeFileSync(file, "export const a = 2;");
    expect(journalCondition(root, okManifest())).toBe("stale");
  });
});

describe("recoverSlot", () => {
  it("falls back to the previous backup when a run stopped while saving its copies", () => {
    protect(distApp(), "OBF:export const a = 1;");
    const before = readFileSync(slot.manifestPath, "utf8");
    renameSync(slot.current, slot.previous);
    mkdirSync(join(slot.current, "files", "dist"), { recursive: true });
    writeFileSync(join(slot.current, "files", "dist", "app.js"), "export const");

    recoverSlot(slot);
    expect(readFileSync(slot.manifestPath, "utf8")).toBe(before);
    expect(readFileSync(copyPath(slot, "dist/app.js"), "utf8")).toBe("export const a = 1;");
    expect(existsSync(slot.previous)).toBe(false);
  });

  it("drops a leftover previous backup once the current one is complete", () => {
    protect(distApp(), "OBF:export const a = 1;");
    mkdirSync(slot.previous, { recursive: true });
    recoverSlot(slot);
    expect(existsSync(slot.previous)).toBe(false);
    expect(existsSync(slot.manifestPath)).toBe(true);
  });
});

describe("readBackupManifest", () => {
  it("reports `missing` when there is no manifest", () => {
    expect(readBackupManifest(slot)).toEqual({ status: "missing" });
  });

  it("reports `corrupt`, distinct from `missing`, on a malformed manifest rather than throwing", () => {
    mkdirSync(slot.current, { recursive: true });
    writeFileSync(slot.manifestPath, "not json");
    expect(readBackupManifest(slot)).toEqual({ status: "corrupt", path: slot.manifestPath });
  });

  it("reports `corrupt` on valid JSON missing the required shape", () => {
    mkdirSync(slot.current, { recursive: true });
    writeFileSync(slot.manifestPath, JSON.stringify({ schema: 1 }));
    expect(readBackupManifest(slot)).toEqual({ status: "corrupt", path: slot.manifestPath });
  });
});

describe("findBackupProjectRoot", () => {
  it("finds the project root directly", () => {
    protect(distApp(), "OBF");
    expect(findBackupProjectRoot(root)).toBe(root);
  });

  it("searches upward from a directory beneath the project root", () => {
    protect(distApp(), "OBF");
    expect(findBackupProjectRoot(join(root, "dist"))).toBe(root);
  });

  it("returns null when nothing is found up to the filesystem root", () => {
    expect(findBackupProjectRoot(root)).toBeNull();
  });

  it("finds a manifest even when it is corrupt (existence, not validity, drives the search)", () => {
    mkdirSync(slot.current, { recursive: true });
    writeFileSync(slot.manifestPath, "not json");
    mkdirSync(join(root, "dist"), { recursive: true });
    expect(findBackupProjectRoot(join(root, "dist"))).toBe(root);
  });

  it("lists every directory's slot and a backup an earlier afterpack left", () => {
    protect(distApp(), "OBF");
    mkdirSync(join(root, ".afterpack", "backup"), { recursive: true });
    writeFileSync(join(root, ".afterpack", "backup", "manifest.json"), "{}");
    expect(slotsUnder(root).map((s) => s.legacy)).toEqual([true, false]);
  });
});

describe("matchAlreadyObfuscated", () => {
  it("matches a file whose current bytes equal the manifest's recorded obfuscated hash", () => {
    const file = distApp();
    protect(file, "OBF:export const a = 1;");
    const current = captureOriginals(root, [file]);
    expect(matchAlreadyObfuscated(okManifest(), current)).toEqual([file]);
  });

  it("does not match once the file changes again (a fresh rebuild)", () => {
    const file = distApp();
    protect(file, "OBF:export const a = 1;");
    writeFileSync(file, "export const a = 1;");
    const current = captureOriginals(root, [file]);
    expect(matchAlreadyObfuscated(okManifest(), current)).toEqual([]);
  });
});
