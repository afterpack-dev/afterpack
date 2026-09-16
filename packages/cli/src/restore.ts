import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { sha256Of } from "@afterpack/integration-utils";
import { CONTACT_FOOTER } from "./args.js";
import {
  absoluteFilePath,
  type BackupManifestFile,
  backupDir,
  readBackupManifest,
} from "./backup.js";
import { EXIT, type ExitCode } from "./exit.js";
import { dim, green, red } from "./format.js";
import { emitJson, jsonError, type OutputMode } from "./output.js";
import type { CliLogger } from "./run.js";

export const RESTORE_USAGE = "usage: afterpack restore [dir]";

export const RESTORE_HELP = `${RESTORE_USAGE}

Restores the original, pre-obfuscation files that a previous \`afterpack\` run backed up to
.afterpack/backup/, undoing that run in place.

Refuses to touch a file whose current bytes no longer match what that run obfuscated it to —
something changed it since, so restoring over it would clobber that change. A missing backup
manifest is also a refusal: there is nothing to restore.

Arguments:
  [dir]                    the project root that holds .afterpack/backup/ (default: the
                           working directory)

Options:
  --diagnostics.format=<text|json>   json prints ONE document on stdout
                           (default: text)
  --help, -h               this help

Exit codes: 0 when every recorded file was restored, 1 when there is no backup manifest or a
recorded file no longer matches, 64 on a usage error.

${dim(CONTACT_FOOTER)}`;

export interface RestoreDeps {
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
  if (deps.mode.format === "json") {
    emitJson(
      deps.logger,
      jsonError({ version: deps.version, command: "restore", exitCode, code, message, fix }),
    );
    return exitCode;
  }
  deps.logger.error(`${red("✗")} ${message}`);
  if (detail.length > 0) {
    deps.logger.error("");
    for (const line of detail) deps.logger.error(`  ${line}`);
  }
  deps.logger.error("");
  deps.logger.error(fix);
  deps.logger.error("");
  deps.logger.error(dim(CONTACT_FOOTER));
  return exitCode;
}

function displayDir(cwd: string, dir: string): string {
  const rel = relative(cwd, dir);
  const path = rel === "" ? "." : rel.startsWith("..") ? dir : rel.split(sep).join("/");
  return `${path}/`;
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
  const target = isAbsolute(requested) ? requested : resolve(cwd, requested);
  if (!existsSync(target)) {
    return fail(
      deps,
      EXIT.failure,
      "PATH_NOT_FOUND",
      `path not found: ${requested}`,
      "Point restore at the project root that holds .afterpack/backup/.",
    );
  }

  const manifest = readBackupManifest(target);
  if (!manifest) {
    return fail(
      deps,
      EXIT.failure,
      "NOTHING_TO_RESTORE",
      "Nothing to restore",
      "Run `afterpack <path>` first — restore reads the backup manifest that run writes.",
    );
  }

  const restored: BackupManifestFile[] = [];
  const mismatched: BackupManifestFile[] = [];
  for (const entry of manifest.files) {
    const currentPath = absoluteFilePath(target, entry.path);
    const matches = existsSync(currentPath) && sha256Of(currentPath) === entry.obfuscatedSha256;
    if (matches) restored.push(entry);
    else mismatched.push(entry);
  }

  const dir = backupDir(target);
  for (const entry of restored) {
    const currentPath = absoluteFilePath(target, entry.path);
    const backupPath = absoluteFilePath(dir, entry.path);
    writeFileSync(currentPath, readFileSync(backupPath));
  }

  if (mismatched.length > 0) {
    const noun = mismatched.length === 1 ? "file" : "files";
    return fail(
      deps,
      EXIT.failure,
      "RESTORE_MISMATCH",
      `${mismatched.length} ${noun} changed since obfuscation — refusing to restore ${noun === "file" ? "it" : "them"}`,
      `Restored the other ${restored.length}; rebuild ${mismatched.length === 1 ? "the file below" : "the files below"} from source instead of restoring over it.`,
      mismatched.map((f) => f.path),
    );
  }

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
      summary: { directory: target, files: restored.length },
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
