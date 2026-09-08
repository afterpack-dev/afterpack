import {
  type AfterpackConfig,
  CONFIG_KEYS,
  type EngineDiagnostic,
  getPath,
  loadConfigFile,
} from "@afterpack/integration-utils";
import { setColorEnabled } from "./format.js";
import type { CliLogger } from "./run.js";

export type DiagnosticsFormat = "text" | "json";
export type DiagnosticsLevel = "summary" | "all" | "none";

export interface OutputMode {
  format: DiagnosticsFormat;
  level: DiagnosticsLevel;
}

export const DEFAULT_OUTPUT_MODE: OutputMode = { format: "text", level: "summary" };

const FORMAT_PATH = "diagnostics.format";
const LEVEL_PATH = "diagnostics.level";

function allowedValues(path: string): readonly string[] {
  const key = CONFIG_KEYS.find((k) => k.path === path);
  return key && key.item.kind === "enum" ? key.item.values : [];
}

function envName(path: string): string {
  return `AFTERPACK_${path.replace(/\./g, "_")}`;
}

export interface OutputModeResult {
  mode: OutputMode;
  issues: string[];
}

function read(
  path: string,
  raw: unknown,
  where: string,
  into: { value?: string },
  issues: string[],
): void {
  if (raw === undefined) return;
  const values = allowedValues(path);
  if (typeof raw !== "string" || !values.includes(raw)) {
    issues.push(
      `\`${path}\`: expected one of: ${values.join(", ")}, got ${JSON.stringify(raw)} (${where})`,
    );
    return;
  }
  into.value = raw;
}

export function resolveOutputMode(input: {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  cwd: string;
}): OutputModeResult {
  const issues: string[] = [];
  const format: { value?: string } = {};
  const level: { value?: string } = {};

  let fileConfig = {} as AfterpackConfig;
  try {
    fileConfig = loadConfigFile(input.cwd).config;
  } catch {
    fileConfig = {} as AfterpackConfig;
  }
  read(FORMAT_PATH, getPath(fileConfig, FORMAT_PATH), "afterpack.json", format, issues);
  read(LEVEL_PATH, getPath(fileConfig, LEVEL_PATH), "afterpack.json", level, issues);

  read(FORMAT_PATH, input.env[envName(FORMAT_PATH)], "environment", format, issues);
  read(LEVEL_PATH, input.env[envName(LEVEL_PATH)], "environment", level, issues);

  for (const token of input.argv) {
    if (token.startsWith(`--${FORMAT_PATH}=`)) {
      read(FORMAT_PATH, token.slice(FORMAT_PATH.length + 3), "command line", format, issues);
    } else if (token.startsWith(`--${LEVEL_PATH}=`)) {
      read(LEVEL_PATH, token.slice(LEVEL_PATH.length + 3), "command line", level, issues);
    }
  }

  return {
    mode: {
      format: (format.value as DiagnosticsFormat | undefined) ?? DEFAULT_OUTPUT_MODE.format,
      level: (level.value as DiagnosticsLevel | undefined) ?? DEFAULT_OUTPUT_MODE.level,
    },
    issues,
  };
}

export function outputModeOf(config: AfterpackConfig): OutputMode {
  return {
    format: (getPath(config, FORMAT_PATH) as DiagnosticsFormat | undefined) ?? "text",
    level: (getPath(config, LEVEL_PATH) as DiagnosticsLevel | undefined) ?? "summary",
  };
}

export function reportingLogger(logger: CliLogger, mode: OutputMode): CliLogger {
  if (mode.format === "json") setColorEnabled(false);
  const log =
    mode.level === "none"
      ? () => {}
      : mode.format === "json"
        ? (m: string) => logger.error(m)
        : (m: string) => logger.log(m);
  return { log, warn: (m) => logger.warn(m), error: (m) => logger.error(m) };
}

export type CommandName = "obfuscate" | "verify" | "audit";

export interface JsonDiagnostic {
  code: string;
  level: string;
  message: string;
  file?: string;
  fix?: string;
}

export interface JsonFile {
  path: string;
  status: string;
  bytesIn: number;
  bytesOut: number;
  diagnostics: JsonDiagnostic[];
}

export interface JsonDocument {
  afterpack: string;
  command: CommandName;
  exitCode: number;
  ok: boolean;
  files: JsonFile[];
  diagnostics: JsonDiagnostic[];
  summary: Record<string, unknown>;
  artifacts: Record<string, string>;
}

export interface JsonErrorDocument {
  afterpack: string;
  command: CommandName;
  exitCode: number;
  ok: false;
  error: { code: string; message: string; fix: string };
}

function isEngineDiagnostic(value: unknown): value is EngineDiagnostic {
  if (typeof value !== "object" || value === null) return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.severity === "string" && typeof d.message === "string" && typeof d.code === "string"
  );
}

export function parseEngineDiagnostics(json: string | null | undefined): EngineDiagnostic[] {
  if (json == null) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter(isEngineDiagnostic) : [];
  } catch {
    return [];
  }
}

export function toJsonDiagnostic(d: EngineDiagnostic): JsonDiagnostic {
  return {
    code: d.code,
    level: d.severity,
    message: d.message.replace(/\s+/g, " ").trim(),
    ...(d.file ? { file: d.file } : {}),
  };
}

export function sortDiagnostics(diagnostics: JsonDiagnostic[]): JsonDiagnostic[] {
  return [...diagnostics].sort(
    (a, b) =>
      (a.file ?? "").localeCompare(b.file ?? "") ||
      a.code.localeCompare(b.code) ||
      a.level.localeCompare(b.level) ||
      a.message.localeCompare(b.message),
  );
}

export function sortedRecord<T>(source: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const name of Object.keys(source).sort()) out[name] = source[name];
  return out;
}

export function emitJson(logger: CliLogger, doc: JsonDocument | JsonErrorDocument): void {
  logger.log(JSON.stringify(doc, null, 2));
}

export function jsonError(input: {
  version: string;
  command: CommandName;
  exitCode: number;
  code: string;
  message: string;
  fix: string;
}): JsonErrorDocument {
  return {
    afterpack: input.version,
    command: input.command,
    exitCode: input.exitCode,
    ok: false,
    error: { code: input.code, message: input.message, fix: input.fix },
  };
}
