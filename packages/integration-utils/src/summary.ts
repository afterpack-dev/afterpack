export type PassSummaryStyle = "cli" | "plugin";

export interface PassSummaryInput {
  label: string;
  fileCount: number;
  inputBytes: number;
  outputBytes: number;
  unobfuscatedCount: number;
  noOpCount: number;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatPassSummary(
  input: PassSummaryInput,
  style: PassSummaryStyle,
  colorGlyph: (glyph: string) => string = (glyph) => glyph,
): string {
  const head = style === "cli" ? colorGlyph("✓") : `[${input.label}]`;
  const files = input.fileCount === 1 ? "file" : "files";
  const tail =
    (input.unobfuscatedCount > 0
      ? ` · ${input.unobfuscatedCount} shipped UNOBFUSCATED (fallback, cleartext)`
      : "") + (input.noOpCount > 0 ? ` · ${input.noOpCount} no-op (unchanged)` : "");
  return (
    `${head} Protected ${input.fileCount} ${files} · ` +
    `${fmtBytes(input.inputBytes)} → ${fmtBytes(input.outputBytes)}${tail}`
  );
}
