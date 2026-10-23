import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import {
  afterpackHome,
  buildDirKey,
  isWithinDir,
  PROTECTION_RECEIPTS_DIR,
  stagedPath,
  writeFileAtomic,
} from "@afterpack/integration-utils";
import { CONTACT_FOOTER } from "./args.js";
import {
  absoluteFilePath,
  addScratch,
  type BackupManifest,
  type BackupManifestFile,
  type BackupSlot,
  backupSlot,
  copiesDir,
  copyPath,
  currentSha256,
  discardSlot,
  entryStatus,
  findBackupProjectRoot,
  hasBackup,
  journalCondition,
  legacySlot,
  mixedJournalFix,
  readBackupManifest,
  recoverSlot,
  slotsUnder,
} from "./backup.js";
import { EXIT, type ExitCode } from "./exit.js";
import { dim, green } from "./format.js";
import { acquireLock, type HeldLock, LockHeldError } from "./lock.js";
import {
  commandFailure,
  displayDir,
  documentPath,
  emitJson,
  JSON_SCHEMA_VERSION,
  type OutputMode,
  realDir,
} from "./output.js";
import type { CliLogger } from "./run.js";

export const RESTORE_USAGE = "usage: afterpack restore [dir]";

export const RESTORE_HELP = `${RESTORE_USAGE}

Restores the original, pre-obfuscation files that a previous \`afterpack\` run backed up to
.afterpack/backups/, undoing that run in place.

Finds .afterpack/backups/ where the \`afterpack\` run kept it: next to the nearest lockfile,
afterpack.json or .git above the build directory (failing those the nearest package.json,
otherwise beside the build directory). Point it at a build directory to undo the run over that
directory, or at the project root to undo every run backed up there.

Undoes every rename the run made, too: a file the run renamed is put back under its original
name, and every file whose references the run rewrote gets its original bytes back. A run that
stopped partway is undone the same way, from the copies it saved before it wrote anything.

Verifies every recorded file against the hash it was obfuscated to BEFORE touching anything (for
a run that stopped partway, against the bytes it was about to write): if any file no longer
matches, or the manifest itself is unreadable, restore changes nothing and fails closed. On success it deletes the backup and the stale protection receipt it recorded in
.afterpack/receipts/, leaving .afterpack/ itself in place.

Arguments:
  [dir]                    a protected build directory, or the project root that
                           holds .afterpack/backups/ (default: the working directory)

Options:
  --diagnostics.format=<text|json>   json prints ONE document on stdout
                           (default: text)
  --help, -h               this help

Exit codes: 0 when every recorded file was restored, 1 when there is no backup manifest, the
manifest is unreadable, or a recorded file no longer matches, 64 on a usage error.

${dim(CONTACT_FOOTER)}`;

interface RestoreDeps {
  cwd: string;
  logger: CliLogger;
  report: CliLogger;
  positionals: string[];
  mode: OutputMode;
  version: string;
}

function fail(
  deps: RestoreDeps,
  exitCode: ExitCode,
  code: string,
  message: string,
  fix: string,
  detail: string[] = [],
): ExitCode {
  return commandFailure(deps, "restore", exitCode, code, message, fix, detail);
}

function isRecordedReceipt(projectRoot: string, receiptPath: string): boolean {
  if (basename(dirname(receiptPath)) !== PROTECTION_RECEIPTS_DIR) return false;
  if (!receiptPath.endsWith(".json")) return false;
  const rel = relative(projectRoot, receiptPath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && existsSync(receiptPath);
}

const NOTHING_TO_RESTORE_FIX =
  "Run `afterpack <path>` first — restore reads the backup manifest that run writes.";

type Selection = { slots: BackupSlot[] } | { elsewhere: string[] };

function protectedRootOf(slot: BackupSlot): string | null {
  recoverSlot(slot);
  const result = readBackupManifest(slot);
  return result.status === "ok" ? result.manifest.protectedRoot : null;
}

function selectSlots(dir: string): Selection {
  const own: BackupSlot[] = [];
  for (const fileTarget of [false, true]) {
    let home: ReturnType<typeof afterpackHome>;
    try {
      home = afterpackHome(dir, { fileTarget });
    } catch {
      continue;
    }
    const slot = backupSlot(home.projectRoot, buildDirKey(home));
    if (hasBackup(slot) && !own.some((s) => s.container === slot.container)) own.push(slot);
    const legacy = legacySlot(home.projectRoot);
    const manifest = readBackupManifest(legacy);
    if (
      manifest.status === "ok" &&
      manifest.manifest.protectedRoot === home.buildDir &&
      !own.some((s) => s.container === legacy.container)
    ) {
      own.push(legacy);
    }
  }
  if (own.length > 0) return { slots: own };
  const projectRoot = findBackupProjectRoot(dir);
  if (projectRoot === null) return { slots: [] };
  const all = slotsUnder(projectRoot);
  const covering = all.filter((slot) => {
    const root = protectedRootOf(slot);
    if (root === null) return true;
    const real = realDir(root);
    return isWithinDir(dir, real) || isWithinDir(real, dir);
  });
  if (covering.length > 0) return { slots: covering };
  return {
    elsewhere: all
      .map(protectedRootOf)
      .filter((root): root is string => root !== null)
      .sort(),
  };
}

interface LoadedSlot {
  slot: BackupSlot;
  manifest: BackupManifest;
  restore: BackupManifestFile[];
}

export function restore(deps: RestoreDeps): ExitCode {
  const { cwd, positionals } = deps;
  if (positionals.length > 1) {
    return fail(
      deps,
      EXIT.usage,
      "TOO_MANY_ARGUMENTS",
      `expected a single [dir], got ${positionals.length}`,
      RESTORE_USAGE,
    );
  }
  const requested = positionals[0] ?? ".";
  const requestedPath = isAbsolute(requested) ? requested : resolve(cwd, requested);
  if (!existsSync(requestedPath)) {
    return fail(
      deps,
      EXIT.failure,
      "PATH_NOT_FOUND",
      `path not found: ${requested}`,
      "Point restore at the project root that holds .afterpack/backups/, or a directory beneath it.",
    );
  }

  const selection = selectSlots(realDir(requestedPath));
  if ("elsewhere" in selection) {
    return fail(
      deps,
      EXIT.failure,
      "NOTHING_TO_RESTORE",
      `No backup covers ${requested}`,
      "Point restore at one of the directories below, or at the project root to restore them all.",
      selection.elsewhere.map((root) => `backed up: ${displayDir(cwd, root)}`),
    );
  }
  const slots = selection.slots;
  if (slots.length === 0) {
    return fail(
      deps,
      EXIT.failure,
      "NOTHING_TO_RESTORE",
      "Nothing to restore",
      NOTHING_TO_RESTORE_FIX,
    );
  }

  const locks: HeldLock[] = [];
  try {
    for (const slot of slots) {
      locks.push(acquireLock(slot.lockPath, (m) => deps.report.log(dim(m))));
    }
    return restoreSlots(deps, slots);
  } catch (error) {
    if (!(error instanceof LockHeldError)) throw error;
    return fail(
      deps,
      EXIT.failure,
      error.code,
      error.message,
      `Wait for that run to finish, then restore. If no afterpack run is going, delete ${documentPath(cwd, error.lockPath)}.`,
    );
  } finally {
    for (const lock of locks) lock.release();
  }
}

function restoreSlots(deps: RestoreDeps, slots: BackupSlot[]): ExitCode {
  const { cwd } = deps;
  const loaded: LoadedSlot[] = [];
  for (const slot of slots) {
    recoverSlot(slot);
    const result = readBackupManifest(slot);
    if (result.status === "corrupt") {
      return fail(
        deps,
        EXIT.failure,
        "BACKUP_MANIFEST_CORRUPT",
        "Backup manifest is unreadable",
        `Delete ${documentPath(cwd, result.path)} and run \`afterpack <path>\` again — ` +
          "a corrupt manifest cannot be restored from.",
      );
    }
    if (result.status === "ok") loaded.push({ slot, manifest: result.manifest, restore: [] });
  }
  if (loaded.length === 0) {
    return fail(
      deps,
      EXIT.failure,
      "NOTHING_TO_RESTORE",
      "Nothing to restore",
      NOTHING_TO_RESTORE_FIX,
    );
  }

  const mismatched: string[] = [];
  let staleInterrupted = false;
  let mixed: BackupSlot | null = null;
  for (const item of loaded) {
    if (
      item.manifest.state === "applying" &&
      journalCondition(item.slot.projectRoot, item.manifest) === "mixed"
    ) {
      mixed ??= item.slot;
    }
    for (const entry of item.manifest.files) {
      const status = entryStatus(item.slot.projectRoot, item.manifest, entry);
      if (status === "unexpected") {
        mismatched.push(entry.path);
        if (item.manifest.state === "applying") staleInterrupted = true;
      } else if (status === "expected") {
        item.restore.push(entry);
      }
    }
  }
  if (mismatched.length > 0) {
    const noun = mismatched.length === 1 ? "file" : "files";
    return fail(
      deps,
      EXIT.failure,
      "RESTORE_MISMATCH",
      staleInterrupted
        ? `${mismatched.length} ${noun} changed since an afterpack run stopped partway — restoring nothing`
        : `${mismatched.length} ${noun} changed since obfuscation — restoring nothing`,
      mixed !== null
        ? mixedJournalFix(documentPath(cwd, copiesDir(mixed)))
        : staleInterrupted
          ? "The build output was rebuilt since that run, so there is nothing to undo. Run " +
            "`afterpack <path>` on it: that discards the stale backup."
          : `Rebuild ${noun === "file" ? "the file below" : "the files below"} from source, then run ` +
            "`afterpack <path>` again before retrying restore.",
      mismatched,
    );
  }

  const missing = loaded.flatMap((item) =>
    item.restore
      .filter(
        (entry) =>
          entry.originalSha256 !== null &&
          currentSha256(copyPath(item.slot, entry.path)) !== entry.originalSha256,
      )
      .map((entry) => ({ entry, slot: item.slot })),
  );
  if (missing.length > 0) {
    const noun = missing.length === 1 ? "file" : "files";
    return fail(
      deps,
      EXIT.failure,
      "BACKUP_INCOMPLETE",
      `The backup is missing the original of ${missing.length} ${noun} — restoring nothing`,
      "This backup cannot undo the run. Rebuild the output from source and run `afterpack " +
        "<path>` on it, which discards a backup the rebuild made stale, or delete " +
        `${documentPath(cwd, missing[0].slot.container)}.`,
      missing.map(({ entry }) => entry.path),
    );
  }

  for (const item of loaded) {
    addScratch(
      item.slot,
      item.manifest,
      item.restore
        .filter((entry) => entry.originalSha256 !== null)
        .map((entry) => stagedPath(absoluteFilePath(item.slot.projectRoot, entry.path))),
    );
  }
  for (const item of loaded) {
    for (const entry of item.restore) {
      const currentPath = absoluteFilePath(item.slot.projectRoot, entry.path);
      if (entry.originalSha256 === null) {
        rmSync(currentPath, { force: true });
        continue;
      }
      mkdirSync(dirname(currentPath), { recursive: true });
      writeFileAtomic(currentPath, readFileSync(copyPath(item.slot, entry.path)));
    }
  }
  for (const { slot, manifest } of loaded) {
    if (manifest.receiptPath && isRecordedReceipt(slot.projectRoot, manifest.receiptPath)) {
      rmSync(manifest.receiptPath, { force: true });
    }
    discardSlot(slot);
    if (!slot.legacy) rmSync(slot.container, { recursive: true, force: true });
  }

  const restored = loaded.flatMap((item) => item.restore);
  if (deps.mode.format === "json") {
    emitJson(deps.logger, {
      schemaVersion: JSON_SCHEMA_VERSION,
      afterpack: deps.version,
      command: "restore",
      exitCode: EXIT.ok,
      ok: true,
      files: [...restored]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((f) => ({
          path: f.path,
          status: "unchanged",
          bytesIn: 0,
          bytesOut: 0,
          diagnostics: [],
        })),
      diagnostics: [],
      summary: { directory: documentPath(cwd, loaded[0].slot.projectRoot), files: restored.length },
      artifacts: {},
    });
    return EXIT.ok;
  }

  const noun = restored.length === 1 ? "file" : "files";
  const renames = loaded.reduce((n, item) => n + item.manifest.renames.length, 0);
  const undone =
    renames > 0 ? dim(` · ${renames} ${renames === 1 ? "rename" : "renames"} undone`) : "";
  const interrupted = loaded.some((item) => item.manifest.state === "applying")
    ? dim(" · undid a run that stopped partway")
    : "";
  const dirs = loaded.map((item) => displayDir(cwd, item.manifest.protectedRoot)).join(", ");
  deps.report.log(
    `${green("✓")} Restored ${restored.length} ${noun} · ${dirs}${undone}${interrupted}`,
  );
  return EXIT.ok;
}
