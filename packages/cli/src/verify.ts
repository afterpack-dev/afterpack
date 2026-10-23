import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  AFTERPACK_DIR,
  afterpackHome,
  locateProtectionReceipt,
  protectionReceiptPath,
  stagedPath,
  verifyProtectionReceipt,
} from "@afterpack/integration-utils";
import { CONTACT_FOOTER } from "./args.js";
import { EXIT, type ExitCode } from "./exit.js";
import { dim, green } from "./format.js";
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

const VERIFY_USAGE = "usage: afterpack verify [dir] [--diagnostics.format=text|json]";

export const VERIFY_HELP = `${VERIFY_USAGE}

Re-checks a build output tree against the protection receipt the build wrote
for it in .afterpack/receipts/, next to the nearest lockfile, afterpack.json or
.git above the tree (failing those the nearest package.json, otherwise beside
the tree): every recorded file must still
hash to the value it was obfuscated to. Run it in the deploy step, after the
build and before the upload.

A MISSING receipt FAILS. This command is only ever run by someone who expects a
protected tree, so "there was nothing to check" is not a pass.

Arguments:
  [dir]                    the build output, or a Next.js project root whose
                           .next/ was protected (default: the working directory)

Options:
  --diagnostics.format=<text|json>   json prints ONE document on stdout
                           (default: text)
  --diagnostics.level=<summary|all|none>
                           none prints nothing on success (default: summary)
  --help, -h               this help

It takes no other options: verification reads a receipt and hashes files, so
there is no configuration for it to honour.

Exit codes: 0 when every recorded file is intact, 1 when the receipt is
missing, is from a different build, or any file no longer matches, 64 on a
usage error.

${dim(CONTACT_FOOTER)}`;

const STAGED_SUFFIX = stagedPath("");

function leftoverTempFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== AFTERPACK_DIR) walk(full);
      } else if (entry.name.endsWith(STAGED_SUFFIX)) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out.sort();
}

function candidates(target: string): string[] {
  return [target, join(target, ".next")];
}

export function readBuildId(dir: string): string | null {
  const path = join(dir, "BUILD_ID");
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

interface VerifyDeps {
  cwd: string;
  logger: CliLogger;
  report: CliLogger;
  positionals: string[];
  mode: OutputMode;
  version: string;
}

function fail(
  deps: VerifyDeps,
  exitCode: ExitCode,
  code: string,
  message: string,
  fix: string,
  detail: string[] = [],
): ExitCode {
  return commandFailure(deps, "verify", exitCode, code, message, fix, detail);
}

export function verify(deps: VerifyDeps): ExitCode {
  const { cwd, positionals } = deps;
  if (positionals.length > 1) {
    return fail(
      deps,
      EXIT.usage,
      "TOO_MANY_ARGUMENTS",
      `expected a single [dir], got ${positionals.length}`,
      VERIFY_USAGE,
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
      "Point verify at the build output directory, or at the project root above it.",
    );
  }

  const target = realDir(requestedPath);
  const dirs = candidates(target).filter((c) => existsSync(c));
  const located =
    dirs.map((c) => locateProtectionReceipt(c, { copies: false })).find((l) => l !== null) ??
    dirs.map((c) => locateProtectionReceipt(c)).find((l) => l !== null);
  if (!located) {
    const looked = dirs.flatMap((c) => [
      ...new Set([
        protectionReceiptPath(c),
        protectionReceiptPath(afterpackHome(c, { fileTarget: true })),
      ]),
    ]);
    return fail(
      deps,
      EXIT.failure,
      "RECEIPT_MISSING",
      `no protection receipt found for ${requested}`,
      "A receipt is written to .afterpack/receipts/ by the run that obfuscated the tree — run " +
        "`afterpack <dir>`, or build again through the framework plugin, then point verify at " +
        "that output directory.",
      [
        ...looked.map((path) => `looked in ${documentPath(cwd, path)}`),
        "and for a receipt whose files this directory holds a copy of",
      ],
    );
  }

  const { dir, receiptPath, copiedFrom } = located;
  const leftovers = leftoverTempFiles(dir);
  if (leftovers.length > 0) {
    return fail(
      deps,
      EXIT.failure,
      "TEMP_FILES_LEFT",
      `${documentPath(cwd, dir)} holds ${leftovers.length} temporary ${leftovers.length === 1 ? "file" : "files"} an afterpack run or restore left when it stopped`,
      "They can hold original source, so never deploy them. Run `afterpack restore`, or rebuild " +
        "the output, then verify again.",
      leftovers.map((path) => documentPath(cwd, path)),
    );
  }
  const { receipt, problems } = verifyProtectionReceipt(receiptPath, dir, readBuildId(dir));
  if (problems.length > 0) {
    return fail(
      deps,
      EXIT.failure,
      "RECEIPT_MISMATCH",
      `${documentPath(cwd, dir)} FAILED verification: ${problems.join("; ")}`,
      "Rebuild the tree with the AfterPack front door and verify the fresh output; " +
        "never deploy a tree whose receipt does not match.",
      problems,
    );
  }

  const files = receipt?.files ?? [];
  if (deps.mode.format === "json") {
    emitJson(deps.logger, {
      schemaVersion: JSON_SCHEMA_VERSION,
      afterpack: deps.version,
      command: "verify",
      exitCode: EXIT.ok,
      ok: true,
      files: [...files]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((f) => ({
          path: f.path,
          status: f.transformed ? "obfuscated" : "unchanged",
          bytesIn: 0,
          bytesOut: 0,
          diagnostics: [],
        })),
      diagnostics: [],
      summary: {
        directory: documentPath(cwd, dir),
        receipt: documentPath(cwd, receiptPath),
        copiedFrom: copiedFrom === null ? null : documentPath(cwd, copiedFrom),
        tool: receipt?.tool ?? null,
        engine: receipt?.engine ?? null,
        bundler: receipt?.bundler ?? null,
        buildId: receipt?.buildId ?? null,
        seed: receipt?.seed ?? null,
        engineVersion: receipt?.engineVersion ?? null,
        files: files.length,
        transformed: files.filter((f) => f.transformed).length,
      },
      artifacts: {},
    });
    return EXIT.ok;
  }

  const engine = receipt?.engine === "cloud" ? " · AfterPack Pro" : "";
  deps.report.log(
    `${green("✓")} Verified ${files.length} ${files.length === 1 ? "file" : "files"} · ` +
      displayDir(deps.cwd, dir) +
      (copiedFrom === null ? "" : dim(` · copy of ${displayDir(deps.cwd, copiedFrom)}`)) +
      engine,
  );
  return EXIT.ok;
}
