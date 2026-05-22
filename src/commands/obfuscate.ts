import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { version } from "../../package.json";
import { bold, cyan, dim, green, header, red } from "../utils/format.js";

/**
 * `obfuscate` command — runs a JavaScript file through the AfterPack engine.
 *
 * STUB: the Rust engine is not implemented yet. This command exercises the
 * real public API surface — it calls `@afterpack/core`'s `process(input,
 * configJson)`, parses the returned `ProcessResult` JSON, and renders
 * diagnostics + a summary line. When the engine ships, only the engine
 * changes; this command already speaks the final contract.
 */

// --- ProcessResult contract (engine.md §2, §6, §18) -------------------------
// Mirrors `@afterpack/core`'s exported `ProcessResult` interface and
// `cloudflare/packages/shared-types`. Declared locally so the command type-
// checks even before `@afterpack/core` is installed (it is loaded lazily).

type Severity = "info" | "error" | "critical";

interface Diagnostic {
  severity: Severity;
  message: string;
  code: string;
}

interface CoverageMetric {
  inflatableBytes: number;
  safetyPreservedBytes: number;
  reflectionPreservedBytes: number;
  userSkippedBytes: number;
  userExcludedBytes: number;
  totalBytes: number;
}

interface ProcessResult {
  code: string;
  sourceMap: string | null;
  coverage: CoverageMetric;
  complexityScore: number;
  diagnostics: Diagnostic[];
  protectionMap: unknown | null;
}

/** Minimal shape of the `@afterpack/core` native module this command uses. */
interface AfterpackCore {
  process(input: string, configJson: string): string;
  version(): string;
}

function printUsage(): void {
  console.log(`
  ${bold("Usage:")} afterpack obfuscate ${cyan("<file.js>")}

  Example: afterpack obfuscate dist/app.js
`);
  process.exit(1);
}

/** Package name of the native engine, kept non-literal so the CLI type-checks
 *  even when `@afterpack/core` is not installed (it is loaded at runtime). */
const CORE_PACKAGE = ["@afterpack", "core"].join("/");

/** Lazily load `@afterpack/core` so the CLI still builds/runs without it. */
async function loadCore(): Promise<AfterpackCore> {
  try {
    // Dynamic import: the native addon is an optional peer at build time.
    const core = (await import(CORE_PACKAGE)) as unknown as AfterpackCore;
    if (typeof core.process !== "function") {
      throw new Error(`${CORE_PACKAGE} does not export process()`);
    }
    return core;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      `\n  ${red("Error:")} The AfterPack engine (@afterpack/core) is not available.` +
        `\n  ${dim(detail)}\n`,
    );
    process.exit(1);
  }
}

/** Render one diagnostic line, colored by severity (engine.md §18). */
function printDiagnostic(d: Diagnostic): void {
  const color = d.severity === "critical" || d.severity === "error" ? red : dim;
  const label = d.severity.toUpperCase();
  console.log(`  ${color(`${label} [${d.code}]`)} ${d.message}`);
}

/** Render the five-way coverage + complexity summary (engine.md §6). */
function printSummary(result: ProcessResult): void {
  const { coverage: c, complexityScore } = result;
  const total = c.totalBytes || 1;
  const pct = (n: number): string => `${Math.round((n / total) * 100)}%`;

  const lines: string[] = [
    `  Inflatable          ${pct(c.inflatableBytes)} — complexity=${complexityScore}`,
  ];
  if (c.safetyPreservedBytes > 0)
    lines.push(`  Safety-preserved    ${pct(c.safetyPreservedBytes)}`);
  if (c.reflectionPreservedBytes > 0)
    lines.push(`  Reflection-preserved ${pct(c.reflectionPreservedBytes)}`);
  if (c.userSkippedBytes > 0)
    lines.push(`  User-skipped        ${pct(c.userSkippedBytes)}`);
  if (c.userExcludedBytes > 0)
    lines.push(`  User-excluded       ${pct(c.userExcludedBytes)}`);
  lines.push(`  Output size         ${result.code.length} bytes`);

  console.log("");
  for (const line of lines) console.log(line);
}

export async function obfuscate(file: string | undefined): Promise<void> {
  if (!file) {
    printUsage();
    return;
  }

  console.log(header(version));

  const filePath = resolve(file);
  let input: string;
  try {
    input = await readFile(filePath, "utf8");
  } catch {
    console.error(`\n  ${red("Error:")} Cannot read file: ${file}\n`);
    process.exit(1);
  }

  console.log(`  Obfuscating ${cyan(file)} ...\n`);

  const core = await loadCore();

  // STUB: an empty config object → the engine uses default configuration.
  let result: ProcessResult;
  try {
    const json = core.process(input, "{}");
    result = JSON.parse(json) as ProcessResult;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`\n  ${red("Error:")} Engine failed: ${dim(detail)}\n`);
    process.exit(1);
  }

  // Render diagnostics (engine.md §18: the CLI owns logging, not the engine).
  for (const d of result.diagnostics) printDiagnostic(d);

  const blocking = result.diagnostics.filter(
    (d) => d.severity === "error" || d.severity === "critical",
  );

  if (blocking.length > 0) {
    // engine.md §18: Error/Critical → no output written, non-zero exit.
    console.error(
      `\n  ${red("✗")} ${bold("Obfuscation failed")} — ${blocking.length} blocking diagnostic${
        blocking.length > 1 ? "s" : ""
      }.\n`,
    );
    process.exit(1);
  }

  printSummary(result);
  console.log(`\n  ${green("✓")} ${bold("Done.")} ${dim("(engine stub)")}\n`);
  process.exit(0);
}
