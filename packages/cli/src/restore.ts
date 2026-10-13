import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { PROTECTION_RECEIPTS_DIR } from "@afterpack/integration-utils";
import { CONTACT_FOOTER } from "./args.js";
import {
  absoluteFilePath,
  type BackupManifest,
  type BackupManifestFile,
  backupDir,
  currentSha256,
  findBackupProjectRoot,
  readBackupManifest,
} from "./backup.js";
import { EXIT, type ExitCode } from "./exit.js";
import { dim, green } from "./format.js";
import {
  commandFailure,
  displayDir,
  documentPath,
  emitJson,
  type OutputMode,
  realDir,
} from "./output.js";
import type { CliLogger } from "./run.js";

export const RESTORE_USAGE = "usage: afterpack restore [dir]";

export const RESTORE_HELP = `${RESTORE_USAGE}

Restores the original, pre-obfuscation files that a previous \`afterpack\` run backed up to
.afterpack/backup/, undoing that run in place.

Finds .afterpack/backup/ where the \`afterpack\` run kept it: next to the nearest lockfile,
afterpack.json or .git above the build directory (failing those the nearest package.json,
otherwise beside the build directory). Point it at that project root or at the build directory
itself.

Undoes every rename the run made, too: a file the run renamed is put back under its original
name, and every file whose references the run rewrote gets its original bytes back. A run that
stopped partway is undone the same way, from the copies it saved before it wrote anything.

Verifies every recorded file against the hash it was obfuscated to BEFORE touching anything: if
any file no longer matches, or the manifest itself is unreadable, restore changes nothing and
fails closed. On success it deletes the backup and the stale protection receipt it recorded in
.afterpack/receipts/, leaving .afterpack/ itself in place.

Arguments:
  [dir]                    a directory at or beneath the project root that holds
                           .afterpack/backup/ (default: the working directory)

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
      "Point restore at the project root that holds .afterpack/backup/, or a directory beneath it.",
    );
  }

  const projectRoot = findBackupProjectRoot(realDir(requestedPath));
  if (projectRoot === null) {
    return fail(
      deps,
      EXIT.failure,
      "NOTHING_TO_RESTORE",
      "Nothing to restore",
      NOTHING_TO_RESTORE_FIX,
    );
  }

  const manifestResult = readBackupManifest(projectRoot);
  if (manifestResult.status === "corrupt") {
    return fail(
      deps,
      EXIT.failure,
      "BACKUP_MANIFEST_CORRUPT",
      "Backup manifest is unreadable",
      `Delete ${documentPath(cwd, manifestResult.path)} and run \`afterpack <path>\` again — ` +
        "a corrupt manifest cannot be restored from.",
    );
  }
  if (manifestResult.status === "missing") {
    return fail(
      deps,
      EXIT.failure,
      "NOTHING_TO_RESTORE",
      "Nothing to restore",
      NOTHING_TO_RESTORE_FIX,
    );
  }
  const manifest = manifestResult.manifest;

  const mismatched = manifest.files.filter((entry) => !restorable(projectRoot, manifest, entry));
  if (mismatched.length > 0) {
    const noun = mismatched.length === 1 ? "file" : "files";
    return fail(
      deps,
      EXIT.failure,
      "RESTORE_MISMATCH",
      `${mismatched.length} ${noun} changed since obfuscation — restoring nothing`,
      `Rebuild ${noun === "file" ? "the file below" : "the files below"} from source, then run ` +
        "`afterpack <path>` again before retrying restore.",
      mismatched.map((f) => f.path),
    );
  }

  const dir = backupDir(projectRoot);
  const restored = manifest.files.filter(
    (entry) => currentSha256(absoluteFilePath(projectRoot, entry.path)) !== entry.originalSha256,
  );
  const missing = restored.filter(
    (entry) =>
      entry.originalSha256 !== null &&
      currentSha256(absoluteFilePath(dir, entry.path)) !== entry.originalSha256,
  );
  if (missing.length > 0) {
    return fail(
      deps,
      EXIT.failure,
      "BACKUP_INCOMPLETE",
      `The backup is missing the original of ${missing.length} ${missing.length === 1 ? "file" : "files"} — restoring nothing`,
      "Rebuild from source instead; this backup cannot undo the run.",
      missing.map((f) => f.path),
    );
  }

  for (const entry of restored) {
    const currentPath = absoluteFilePath(projectRoot, entry.path);
    if (entry.originalSha256 === null) {
      rmSync(currentPath, { force: true });
      continue;
    }
    mkdirSync(dirname(currentPath), { recursive: true });
    const staged = `${currentPath}.afterpack-restore`;
    writeFileSync(staged, readFileSync(absoluteFilePath(dir, entry.path)));
    renameSync(staged, currentPath);
  }

  if (manifest.receiptPath && isRecordedReceipt(projectRoot, manifest.receiptPath)) {
    rmSync(manifest.receiptPath, { force: true });
  }
  rmSync(dir, { recursive: true, force: true });

  if (deps.mode.format === "json") {
    emitJson(deps.logger, {
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
      summary: { directory: documentPath(cwd, projectRoot), files: restored.length },
      artifacts: {},
    });
    return EXIT.ok;
  }

  const noun = restored.length === 1 ? "file" : "files";
  const renames = manifest.renames.length;
  const undone =
    renames > 0 ? dim(` · ${renames} ${renames === 1 ? "rename" : "renames"} undone`) : "";
  const interrupted =
    manifest.state === "applying" ? dim(" · undid a run that stopped partway") : "";
  deps.report.log(
    `${green("✓")} Restored ${restored.length} ${noun} · ${displayDir(cwd, manifest.protectedRoot)}` +
      undone +
      interrupted,
  );
  return EXIT.ok;
}

function restorable(
  projectRoot: string,
  manifest: BackupManifest,
  entry: BackupManifestFile,
): boolean {
  const current = currentSha256(absoluteFilePath(projectRoot, entry.path));
  if (entry.obfuscatedSha256 !== undefined && current === entry.obfuscatedSha256) return true;
  if (manifest.state !== "applying") return false;
  return entry.obfuscatedSha256 === undefined || current === entry.originalSha256;
}
