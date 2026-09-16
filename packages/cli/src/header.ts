import { bold, colorSupported, dim, gold, isCiTruthy } from "./format.js";
import type { OutputMode } from "./output.js";
import type { CliLogger, CliStdout } from "./run.js";

interface HeaderInput {
  stdout: CliStdout;
  env: Record<string, string | undefined>;
  version: string;
  mode: OutputMode;
  report: CliLogger;
}

const WORDMARK = "AfterPack";
const SWEEP_STEP_MS = 30;

function tagline(version: string): string {
  return `v${version} • Protect your builds`;
}

function plainLine(version: string): string {
  return `${WORDMARK} ${tagline(version)}`;
}

function coloredLine(version: string): string {
  return `${gold(bold(WORDMARK))} ${dim(tagline(version))}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sweep(stdout: CliStdout, version: string): Promise<void> {
  for (let i = 1; i <= WORDMARK.length; i++) {
    const done = gold(bold(WORDMARK.slice(0, i)));
    const pending = dim(WORDMARK.slice(i));
    stdout.write(`\r\x1b[2K${done}${pending} ${dim(tagline(version))}`);
    await sleep(SWEEP_STEP_MS);
  }
  stdout.write(`\r\x1b[2K${coloredLine(version)}\n\n`);
}

export async function printHeader(input: HeaderInput): Promise<void> {
  if (input.mode.level === "none") return;
  if (input.mode.format === "json") {
    input.report.log(plainLine(input.version));
    return;
  }
  const useColor = colorSupported(input.env, input.stdout.isTTY);
  if (input.stdout.isTTY && useColor && !isCiTruthy(input.env.CI)) {
    await sweep(input.stdout, input.version);
    return;
  }
  input.report.log(useColor ? coloredLine(input.version) : plainLine(input.version));
  input.report.log("");
}
