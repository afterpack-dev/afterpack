import { dim, gold } from "./format.js";
import type { OutputMode } from "./output.js";
import type { CliLogger, CliStdout } from "./run.js";

interface WithProgressInput<T> {
  stdout: CliStdout;
  mode: OutputMode;
  report: CliLogger;
  label: string;
  work: () => Promise<T>;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PULSE_BRIGHT = [true, true, false, false];
const FRAME_MS = 120;
const DEFER_MS = 150;

function startSpinner(stdout: CliStdout, label: string): () => void {
  let frame = 0;
  const timer = setInterval(() => {
    const glyph = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
    const bright = PULSE_BRIGHT[frame % PULSE_BRIGHT.length];
    const colored = bright ? gold(glyph) : dim(gold(glyph));
    stdout.write(`\r\x1b[2K${colored} ${label}`);
    frame += 1;
  }, FRAME_MS);
  return () => {
    clearInterval(timer);
    stdout.write("\r\x1b[2K");
  };
}

export async function withProgress<T>(input: WithProgressInput<T>): Promise<T> {
  if (input.mode.level === "none") return input.work();
  if (!input.stdout.isTTY || input.mode.format === "json") {
    input.report.log(input.label);
    return input.work();
  }
  const spinner: { stop: (() => void) | null } = { stop: null };
  const deferred = setTimeout(() => {
    spinner.stop = startSpinner(input.stdout, input.label);
  }, DEFER_MS);
  try {
    return await input.work();
  } finally {
    clearTimeout(deferred);
    spinner.stop?.();
  }
}
