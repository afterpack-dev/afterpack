import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { PROTECTION_RECEIPT_FILE, verifyProtectionReceipt } from "@afterpack/integration-utils";
import { CONTACT_FOOTER } from "./args.js";
import { EXIT, type ExitCode } from "./exit.js";
import { dim, green, red } from "./format.js";
import { emitJson, jsonError, type OutputMode } from "./output.js";
import type { CliLogger } from "./run.js";

export const VERIFY_USAGE = "usage: afterpack verify [dir] [--diagnostics.format=text|json]";

export const VERIFY_HELP = `${VERIFY_USAGE}

Re-checks a build output tree against the protection receipt the build wrote
into it: every recorded file must still hash to the value it was obfuscated to.
Run it in the deploy step, after the build and before the upload.

A MISSING receipt FAILS. This command is only ever run by someone who expects a
protected tree, so "there was nothing to check" is not a pass.

Arguments:
  [dir]                    the build output, or a project root whose .next/
                           holds the receipt (default: the working directory)

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

export interface VerifyDeps {
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
  if (deps.mode.format === "json") {
    emitJson(
      deps.logger,
      jsonError({ version: deps.version, command: "verify", exitCode, code, message, fix }),
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
  const path = rel === "" || rel.startsWith("..") ? dir : rel.split(sep).join("/");
  return `${path}/`;
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
  const target = isAbsolute(requested) ? requested : resolve(cwd, requested);
  if (!existsSync(target)) {
    return fail(
      deps,
      EXIT.failure,
      "PATH_NOT_FOUND",
      `path not found: ${requested}`,
      "Point verify at the build output directory, or at the project root above it.",
    );
  }

  const dir = candidates(target).find((c) => existsSync(join(c, PROTECTION_RECEIPT_FILE)));
  if (!dir) {
    return fail(
      deps,
      EXIT.failure,
      "RECEIPT_MISSING",
      `no protection receipt found for ${requested}`,
      "A receipt is written by the run that obfuscated the tree — run `afterpack <dir>`, or " +
        "build again through the framework plugin, then point verify at that output directory.",
      candidates(target).map((c) => `looked in ${join(c, PROTECTION_RECEIPT_FILE)}`),
    );
  }

  const { receipt, problems } = verifyProtectionReceipt(dir, readBuildId(dir));
  if (problems.length > 0) {
    return fail(
      deps,
      EXIT.failure,
      "RECEIPT_MISMATCH",
      `${dir} FAILED verification: ${problems.join("; ")}`,
      "Rebuild the tree with the AfterPack front door and verify the fresh output; " +
        "never deploy a tree whose receipt does not match.",
      problems,
    );
  }

  const files = receipt?.files ?? [];
  if (deps.mode.format === "json") {
    emitJson(deps.logger, {
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
        directory: dir,
        tool: receipt?.tool ?? null,
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

  deps.report.log(
    `${green("✓")} Verified ${files.length} ${files.length === 1 ? "file" : "files"} · ` +
      displayDir(deps.cwd, dir),
  );
  return EXIT.ok;
}
