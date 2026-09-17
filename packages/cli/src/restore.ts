import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { PROTECTION_RECEIPT_FILE, sha256Of } from "@afterpack/integration-utils";
import { CONTACT_FOOTER } from "./args.js";
import {
  absoluteFilePath,
  type BackupManifestFile,
  backupDir,
  findBackupProjectRoot,
  readBackupManifest,
} from "./backup.js";
import { EXIT, type ExitCode } from "./exit.js";
import { dim, green } from "./format.js";
import { commandFailure, displayDir, documentPath, emitJson, type OutputMode } from "./output.js";
import type { CliLogger } from "./run.js";

export const RESTORE_USAGE = "usage: afterpack restore [dir]";

export const RESTORE_HELP = `${RESTORE_USAGE}

Restores the original, pre-obfuscation files that a previous \`afterpack\` run backed up to
.afterpack/backup/, undoing that run in place.

Searches upward from [dir] (or the working directory) for the project root that holds
.afterpack/backup/ — the same directory the \`afterpack\` run was launched from — so restore
works whether it is pointed at that root or at the build directory beneath it.

Verifies every recorded file against the hash it was obfuscated to BEFORE touching anything: if
any file no longer matches, or the manifest itself is unreadable, restore changes nothing and
fails closed. On success it deletes the backup and the stale protection receipt it recorded,
leaving .afterpack/ itself in place.

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
  if (basename(receiptPath) !== PROTECTION_RECEIPT_FILE) return false;
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
  const target = isAbsolute(requested) ? requested : resolve(cwd, requested);
  if (!existsSync(target)) {
    return fail(
      deps,
      EXIT.failure,
      "PATH_NOT_FOUND",
      `path not found: ${requested}`,
      "Point restore at the project root that holds .afterpack/backup/, or a directory beneath it.",
    );
  }

  const projectRoot = findBackupProjectRoot(target);
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

  const mismatched: BackupManifestFile[] = [];
  for (const entry of manifest.files) {
    const currentPath = absoluteFilePath(projectRoot, entry.path);
    const matches = existsSync(currentPath) && sha256Of(currentPath) === entry.obfuscatedSha256;
    if (!matches) mismatched.push(entry);
  }

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
  for (const entry of manifest.files) {
    const currentPath = absoluteFilePath(projectRoot, entry.path);
    const backupPath = absoluteFilePath(dir, entry.path);
    writeFileSync(currentPath, readFileSync(backupPath));
  }

  if (manifest.receiptPath && isRecordedReceipt(projectRoot, manifest.receiptPath)) {
    rmSync(manifest.receiptPath, { force: true });
  }
  rmSync(dir, { recursive: true, force: true });

  const restored = manifest.files;
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
  deps.report.log(
    `${green("✓")} Restored ${restored.length} ${noun} · ${displayDir(cwd, manifest.protectedRoot)}`,
  );
  return EXIT.ok;
}
