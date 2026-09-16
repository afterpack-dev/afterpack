export type EngineSeverity = "info" | "error" | "critical";

export interface EngineSpan {
  startByte: number;
  endByte: number;
}

export type EngineDiagnosticData = { kind: string } & Record<string, unknown>;

export interface EngineDiagnostic {
  severity: EngineSeverity;
  message: string;
  code: string;
  span?: EngineSpan | null;
  file?: string | null;
  data?: EngineDiagnosticData | null;
}

export type DiagnosticsVerbosity = "summary" | "all" | "none";

const ISSUES_URL = "https://github.com/afterpack-dev/afterpack/issues";

export interface DiagnosticsSummary {
  total: number;
  info: number;
  error: number;
  critical: number;
  byCode: Record<string, number>;
}

interface DiagnosticCarrier {
  filePath?: string;
  diagnostics?: string;
}

interface ParsedDiagnostics {
  diagnostics: EngineDiagnostic[];
  malformed: number;
}

interface CollectedDiagnostics {
  diagnostics: EngineDiagnostic[];
  unknownFiles: number;
  malformedEntries: number;
}

const MAX_INSTANCES_PER_CODE = 5;

const MAX_CODES_IN_SUMMARY = 6;

const SEVERITY_RANK: Record<string, number> = { critical: 0, error: 1, info: 2 };

function isEngineDiagnostic(value: unknown): value is EngineDiagnostic {
  if (typeof value !== "object" || value === null) return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.severity === "string" && typeof d.message === "string" && typeof d.code === "string"
  );
}

export function parseDiagnosticsJson(json: string | null | undefined): ParsedDiagnostics | null {
  if (json == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const diagnostics = parsed.filter(isEngineDiagnostic);
  return { diagnostics, malformed: parsed.length - diagnostics.length };
}

export function collectDiagnostics(files: readonly DiagnosticCarrier[]): CollectedDiagnostics {
  const diagnostics: EngineDiagnostic[] = [];
  let unknownFiles = 0;
  let malformedEntries = 0;
  for (const file of files) {
    const parsed = parseDiagnosticsJson(file.diagnostics);
    if (parsed === null) {
      unknownFiles += 1;
      continue;
    }
    malformedEntries += parsed.malformed;
    for (const d of parsed.diagnostics) {
      diagnostics.push(d.file || !file.filePath ? d : { ...d, file: file.filePath });
    }
  }
  return { diagnostics, unknownFiles, malformedEntries };
}

export function resolveDiagnosticsVerbosity(
  option: DiagnosticsVerbosity | undefined,
): DiagnosticsVerbosity {
  return option ?? "summary";
}

function formatLocator(d: EngineDiagnostic): string | null {
  const span = d.span ? `bytes ${d.span.startByte}..${d.span.endByte}` : null;
  if (d.file && span) return `${d.file} ${span}`;
  return d.file || span;
}

function formatData(data: EngineDiagnosticData | null | undefined): string | null {
  if (!data) return null;
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (key === "kind" || value === null || value === undefined) continue;
    pairs.push(typeof value === "string" ? `${key}="${value}"` : `${key}=${String(value)}`);
  }
  return pairs.length > 0 ? pairs.join(" ") : null;
}

export function formatDiagnostic(d: EngineDiagnostic): string {
  const parts = [`${d.severity} ${d.code}`];
  const locator = formatLocator(d);
  if (locator) parts.push(locator);
  const message = d.message.replace(/\s+/g, " ").trim();
  if (message) parts.push(message);
  const data = formatData(d.data);
  if (data) parts.push(data);
  return parts.join(" · ");
}

export const DIAG_ALREADY_OBFUSCATED = "DIAG_ALREADY_OBFUSCATED";

export class AlreadyObfuscatedError extends Error {
  readonly code = DIAG_ALREADY_OBFUSCATED;
  readonly files: readonly string[];
  readonly receiptPath: string;
  readonly dir: string;

  constructor(message: string, files: readonly string[], receiptPath: string, dir: string) {
    super(message);
    this.name = "AlreadyObfuscatedError";
    this.files = files;
    this.receiptPath = receiptPath;
    this.dir = dir;
  }
}

const ALREADY_OBFUSCATED_FILE_CAP = 10;

export function formatAlreadyObfuscatedMessage(input: {
  files: readonly string[];
  receiptPath: string;
  dir: string;
}): string {
  const { files, receiptPath, dir } = input;
  const shown = files.slice(0, ALREADY_OBFUSCATED_FILE_CAP);
  const hidden = files.length - shown.length;
  const list = hidden > 0 ? `${shown.join(", ")}, and ${hidden} more` : shown.join(", ");
  return (
    `error ${DIAG_ALREADY_OBFUSCATED} · ${files.length} file(s) already carry AfterPack's ` +
    `obfuscated output from a previous run (matched by content hash against ${receiptPath}): ` +
    `${list} — rebuild from source before running AfterPack again (delete \`${dir}\` or run your ` +
    "bundler's clean); AfterPack output is not idempotent"
  );
}

export function summarizeDiagnostics(diagnostics: EngineDiagnostic[]): DiagnosticsSummary {
  const summary: DiagnosticsSummary = { total: 0, info: 0, error: 0, critical: 0, byCode: {} };
  for (const d of diagnostics) {
    summary.total += 1;
    if (d.severity === "critical" || d.severity === "error" || d.severity === "info") {
      summary[d.severity] += 1;
    }
    summary.byCode[d.code] = (summary.byCode[d.code] ?? 0) + 1;
  }
  return summary;
}

function groupByCode(diagnostics: EngineDiagnostic[]): Map<string, EngineDiagnostic[]> {
  const groups = new Map<string, EngineDiagnostic[]>();
  for (const d of diagnostics) {
    const existing = groups.get(d.code);
    if (existing) existing.push(d);
    else groups.set(d.code, [d]);
  }
  return groups;
}

function formatInfoSummary(infos: EngineDiagnostic[]): string {
  const byCode = [...groupByCode(infos).entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );
  const shown = byCode.slice(0, MAX_CODES_IN_SUMMARY);
  const parts = shown.map(([code, list]) => `${code} x${list.length}`);
  const hidden = byCode.length - shown.length;
  if (hidden > 0) parts.push(`+${hidden} more code(s)`);
  return `${infos.length} info diagnostic(s): ${parts.join(" · ")}`;
}

interface ReportDiagnosticsInput {
  diagnostics: EngineDiagnostic[];
  malformedEntries?: number;
  logger: { warn: (message: string) => void; log: (message: string) => void };
  prefix: (message: string) => string;
  verbosity?: DiagnosticsVerbosity;
}

export function reportDiagnostics(input: ReportDiagnosticsInput): DiagnosticsSummary {
  const { diagnostics, logger, prefix } = input;
  const verbosity = resolveDiagnosticsVerbosity(input.verbosity);
  const malformedEntries = input.malformedEntries ?? 0;
  const summary = summarizeDiagnostics(diagnostics);
  if (malformedEntries > 0) {
    logger.warn(
      prefix(
        `${malformedEntries} diagnostic entry/entries did not match the engine's diagnostic ` +
          "contract and were dropped — treat this build's diagnostics as incomplete.",
      ),
    );
  }
  if (diagnostics.length === 0) return summary;

  const infos = verbosity === "all" ? diagnostics.filter((d) => d.severity === "info") : [];
  if (infos.length > 0) {
    logger.log(prefix(formatInfoSummary(infos)));
    for (const d of infos) logger.log(prefix(formatDiagnostic(d)));
  }

  const loud = diagnostics
    .filter((d) => d.severity !== "info")
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 1) - (SEVERITY_RANK[b.severity] ?? 1));
  for (const [code, list] of groupByCode(loud)) {
    const cap = verbosity === "all" ? list.length : MAX_INSTANCES_PER_CODE;
    for (const d of list.slice(0, cap)) logger.warn(prefix(formatDiagnostic(d)));
    const hidden = list.length - cap;
    if (hidden > 0) {
      logger.warn(
        prefix(
          `${list[0].severity} ${code} · +${hidden} more occurrence(s) ` +
            "(AFTERPACK_diagnostics_level=all to list them)",
        ),
      );
    }
  }

  if (summary.critical > 0) {
    logger.warn(
      prefix(
        `${summary.critical} critical diagnostic(s) above are engine bugs — please report them ` +
          `at ${ISSUES_URL}, quoting the code(s).`,
      ),
    );
  }
  return summary;
}
