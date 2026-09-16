export function colorSupported(env: Record<string, string | undefined>, isTTY: boolean): boolean {
  return (
    env.FORCE_COLOR !== "0" && !env.NO_COLOR && (env.FORCE_COLOR !== undefined || isTTY === true)
  );
}

export function isCiTruthy(value: string | undefined): boolean {
  if (value === undefined || value === "") return false;
  return value !== "0" && value.toLowerCase() !== "false";
}

let enabled = colorSupported(process.env, process.stdout.isTTY === true);

export function setColorEnabled(value: boolean): void {
  enabled = value;
}

export function isColorEnabled(): boolean {
  return enabled;
}

function ansi(open: string, close: string): (text: string) => string {
  return (text: string) => (enabled ? `\x1b[${open}m${text}\x1b[${close}m` : text);
}

export const bold = ansi("1", "22");
export const dim = ansi("2", "22");
export const red = ansi("31", "39");
export const green = ansi("32", "39");
export const yellow = ansi("33", "39");
export const cyan = ansi("36", "39");

const GOLD_RGB = [234, 174, 61] as const;
const GOLD_256 = 214;

function trueColorSupported(env: Record<string, string | undefined>): boolean {
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  return colorterm === "truecolor" || colorterm === "24bit";
}

export function gold(text: string): string {
  if (!enabled) return text;
  const [r, g, b] = GOLD_RGB;
  return trueColorSupported(process.env)
    ? `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`
    : `\x1b[38;5;${GOLD_256}m${text}\x1b[39m`;
}

export function severityColor(severity: string): (text: string) => string {
  switch (severity.toLowerCase()) {
    case "critical":
    case "high":
      return red;
    case "medium":
      return yellow;
    case "low":
      return cyan;
    default:
      return dim;
  }
}

export function header(version: string): string {
  return `\n  ${bold(`AfterPack v${version}`)} — Security Analyzer\n`;
}

export function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ESC byte is the point.
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}
