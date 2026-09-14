import {
  type AfterpackConfig,
  type ConfigIssue,
  type EngineDiagnostic,
  getPath,
  type LoadedConfigFile,
  loadConfigFile,
  mergeConfig,
  parseCliOptions,
  parseEnvOptions,
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

export interface OutputModeResult {
  mode: OutputMode;
  issues: string[];
}

const OUTPUT_PATHS: ReadonlySet<string> = new Set([FORMAT_PATH, LEVEL_PATH]);

function outputIssues(issues: readonly ConfigIssue[]): string[] {
  return issues.filter((issue) => OUTPUT_PATHS.has(issue.path)).map((issue) => issue.message);
}

const NO_CONFIG_FILE: LoadedConfigFile = {
  path: null,
  config: {} as AfterpackConfig,
  issues: [],
};

export function resolveOutputMode(input: {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  cwd: string;
}): OutputModeResult {
  let file = NO_CONFIG_FILE;
  try {
    file = loadConfigFile(input.cwd);
  } catch {
    file = NO_CONFIG_FILE;
  }
  const env = parseEnvOptions(input.env);
  const cli = parseCliOptions([...input.argv]);
  const config = mergeConfig(mergeConfig(file.config, env.config), cli.config);
  return {
    mode: outputModeOf(config),
    issues: [
      ...outputIssues(file.issues),
      ...outputIssues(env.issues),
      ...outputIssues(cli.issues),
    ],
  };
}

export function outputModeOf(config: AfterpackConfig): OutputMode {
  return {
    format:
      (getPath(config, FORMAT_PATH) as DiagnosticsFormat | undefined) ?? DEFAULT_OUTPUT_MODE.format,
    level:
      (getPath(config, LEVEL_PATH) as DiagnosticsLevel | undefined) ?? DEFAULT_OUTPUT_MODE.level,
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
