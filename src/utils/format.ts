const isColorSupported =
  process.env.FORCE_COLOR !== "0" &&
  !process.env.NO_COLOR &&
  (process.env.FORCE_COLOR !== undefined || process.stdout.isTTY);

function ansi(open: string, close: string) {
  return (text: string) =>
    isColorSupported ? `\x1b[${open}m${text}\x1b[${close}m` : text;
}

export const bold = ansi("1", "22");
export const dim = ansi("2", "22");
export const red = ansi("31", "39");
export const green = ansi("32", "39");
export const yellow = ansi("33", "39");
export const cyan = ansi("36", "39");

export function severityColor(severity: string): (text: string) => string {
  switch (severity.toLowerCase()) {
    case "critical":
      return red;
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
