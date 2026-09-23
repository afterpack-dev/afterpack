import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { EngineDiagnostic, EngineDiagnosticData } from "./diagnostics.js";
import { type NoticeLogger, reportNotices } from "./notices.js";
import type { EnvLike, Preset } from "./policy.js";

const API_URL_ENV_VAR = "AFTERPACK_API_URL";

export const DEFAULT_API_URL = "https://api.afterpack.dev";

export const TELEMETRY_ENDPOINT_PATH = "/v1/telemetry/build";

const TELEMETRY_PAYLOAD_VERSION = 1;

const TELEMETRY_TIMEOUT_MS = 1500;

export const INSTALL_ID_ROTATION_DAYS = 30;

export const TELEMETRY_DIAGNOSTIC_LIMIT = 20;

const TELEMETRY_STATE_FILE = join(homedir(), ".afterpack", "telemetry.json");

const TOKEN_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export type TelemetrySeverity = "error" | "critical";

export interface TelemetrySpan {
  startByte: number;
  endByte: number;
}

const DATA_FIELD_WHITELIST: Readonly<Record<string, readonly string[]>> = {
  outputUnparseable: ["parserErrorKind", "outputByteOffset"],
  parseError: ["parserErrorKind"],
  engineBug: ["phase", "transform", "nodeKind"],
  inflationBudget: ["target", "achieved", "budgetRatio", "inflationRatio"],
  configParse: ["category", "line", "column"],
};

export type TelemetryDiagnosticData = { kind: string } & Record<string, string | number>;

export interface TelemetryDiagnostic {
  code: string;
  severity: TelemetrySeverity;
  span: TelemetrySpan | null;
  data: TelemetryDiagnosticData | null;
  message?: never;
  file?: never;
}

export interface TelemetryPayload {
  version: number;
  installId: string;
  framework: string;
  frameworkVersion: string | null;
  engineVersion: string | null;
  clientVersion: string | null;
  nodeVersion: string;
  os: string;
  arch: string;
  ci: boolean;
  complexity: string;
  fileCountBucket: string;
  durationBucket: string;
  diagnostics: TelemetryDiagnostic[];
  errorCount: number;
  criticalCount: number;
  droppedCount: number;
}

export interface TelemetryFacts {
  label: string;
  projectRoot: string;
  diagnostics: readonly EngineDiagnostic[];
  fileCount: number;
  durationMs: number;
  preset?: Preset;
  complexity?: number;
  engineVersion?: string | null;
  clientVersion?: string | null;
}

export interface TelemetryContext {
  installId: string;
  env?: EnvLike;
  runtime?: { node: string; platform: string; arch: string };
}

export type TelemetryReporter = (facts: TelemetryFacts | null) => Promise<void>;

export function resolveTelemetryEnabled(option: boolean | undefined, env: EnvLike = {}): boolean {
  if (option !== undefined) return option;
  return !(env.NODE_ENV === "test" || env.VITEST);
}

interface FrameworkEntry {
  label: string;
  name: string;
  pkg?: string;
}

const FRAMEWORK_ENTRIES: readonly FrameworkEntry[] = [
  { label: "afterpack", name: "cli" },
  { label: "afterpack-angular", name: "angular", pkg: "@angular/core" },
  { label: "afterpack-esbuild", name: "esbuild", pkg: "esbuild" },
  { label: "afterpack-next", name: "next", pkg: "next" },
  { label: "afterpack-rollup", name: "rollup", pkg: "rollup" },
  { label: "afterpack-vite", name: "vite", pkg: "vite" },
  { label: "afterpack-webpack", name: "webpack", pkg: "webpack" },
];

const FRAMEWORK_BY_LABEL: ReadonlyMap<string, string> = new Map(
  FRAMEWORK_ENTRIES.map((e) => [e.label, e.name]),
);

const FRAMEWORK_PACKAGE_BY_NAME: ReadonlyMap<string, string> = new Map(
  FRAMEWORK_ENTRIES.flatMap((e) => (e.pkg ? [[e.name, e.pkg] as const] : [])),
);

export function frameworkFromLabel(label: string): string {
  return FRAMEWORK_BY_LABEL.get(label.split(":")[0]) ?? "unknown";
}

const VERSION_RANGE_PATTERN = /^[\sv0-9.\-+*xX^~><=|]{1,32}$/;

export function detectFrameworkVersion(projectRoot: string, framework: string): string | null {
  const pkgName = FRAMEWORK_PACKAGE_BY_NAME.get(framework);
  if (!pkgName) return null;
  let deps: Record<string, unknown>;
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    deps = { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    return null;
  }
  const raw = deps[pkgName];
  if (typeof raw !== "string") return null;
  const range = raw.trim();
  return VERSION_RANGE_PATTERN.test(range) && /[0-9*xX]/.test(range) ? range : null;
}

function complexityLabel(preset: Preset | undefined, complexity: number | undefined): string {
  if (preset !== undefined) return preset;
  return complexity === undefined ? "default" : "custom";
}

const FILE_COUNT_BUCKETS: readonly number[] = [1, 5, 20, 100, 500, 2000];

export function fileCountBucket(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0";
  let lower = 1;
  for (const upper of FILE_COUNT_BUCKETS) {
    if (count <= upper) return lower === upper ? `${upper}` : `${lower}-${upper}`;
    lower = upper + 1;
  }
  return `${FILE_COUNT_BUCKETS[FILE_COUNT_BUCKETS.length - 1]}+`;
}

const DURATION_BUCKETS_MS: readonly [number, string][] = [
  [1000, "<1s"],
  [5000, "1-5s"],
  [15000, "5-15s"],
  [60000, "15-60s"],
  [300000, "60-300s"],
];

export function durationBucket(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  for (const [upper, label] of DURATION_BUCKETS_MS) {
    if (ms < upper) return label;
  }
  return "300s+";
}

function safeScalar(value: unknown): string | number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return TOKEN_PATTERN.test(value) ? value : null;
  return null;
}

function telemetrySafeData(
  data: EngineDiagnosticData | null | undefined,
): TelemetryDiagnosticData | null {
  if (!data || typeof data.kind !== "string") return null;
  const kind = TOKEN_PATTERN.test(data.kind) ? data.kind : null;
  if (kind === null) return null;
  const out: TelemetryDiagnosticData = { kind };
  for (const field of DATA_FIELD_WHITELIST[kind] ?? []) {
    const value = safeScalar((data as Record<string, unknown>)[field]);
    if (value !== null) out[field] = value;
  }
  return out;
}

function telemetrySafeSpan(d: EngineDiagnostic): TelemetrySpan | null {
  const span = d.span;
  if (!span) return null;
  const start = safeScalar(span.startByte);
  const end = safeScalar(span.endByte);
  if (typeof start !== "number" || typeof end !== "number") return null;
  if (start < 0 || end < 0) return null;
  return { startByte: start, endByte: end };
}

export function telemetrySafeDiagnostic(
  d: EngineDiagnostic,
  severity: TelemetrySeverity,
): TelemetryDiagnostic {
  return {
    code: TOKEN_PATTERN.test(d.code) ? d.code : "DIAG_UNKNOWN",
    severity,
    span: telemetrySafeSpan(d),
    data: telemetrySafeData(d.data),
  };
}

export function buildTelemetryPayload(
  facts: TelemetryFacts,
  ctx: TelemetryContext,
): TelemetryPayload | null {
  let errorCount = 0;
  let criticalCount = 0;
  const alerting: TelemetryDiagnostic[] = [];
  for (const d of facts.diagnostics) {
    if (d.severity !== "error" && d.severity !== "critical") continue;
    if (d.severity === "critical") criticalCount += 1;
    else errorCount += 1;
    alerting.push(telemetrySafeDiagnostic(d, d.severity));
  }
  if (alerting.length === 0) return null;

  const kept = alerting.slice(-TELEMETRY_DIAGNOSTIC_LIMIT);
  const env = ctx.env ?? {};
  const runtime = ctx.runtime ?? {
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  };
  const framework = frameworkFromLabel(facts.label);
  return {
    version: TELEMETRY_PAYLOAD_VERSION,
    installId: ctx.installId,
    framework,
    frameworkVersion: detectFrameworkVersion(facts.projectRoot, framework),
    engineVersion: safeVersion(facts.engineVersion),
    clientVersion: safeVersion(facts.clientVersion),
    nodeVersion: safeVersion(runtime.node) ?? "unknown",
    os: safeToken(runtime.platform),
    arch: safeToken(runtime.arch),
    ci: env.CI === "true",
    complexity: complexityLabel(facts.preset, facts.complexity),
    fileCountBucket: fileCountBucket(facts.fileCount),
    durationBucket: durationBucket(facts.durationMs),
    diagnostics: kept,
    errorCount,
    criticalCount,
    droppedCount: alerting.length - kept.length,
  };
}

const VERSION_PATTERN = /^[0-9][0-9A-Za-z.\-+]{0,31}$/;

function safeVersion(value: string | null | undefined): string | null {
  return typeof value === "string" && VERSION_PATTERN.test(value) ? value : null;
}

function safeToken(value: string): string {
  return TOKEN_PATTERN.test(value) ? value : "unknown";
}

export const TELEMETRY_NOTICE: readonly string[] = [
  "AfterPack: anonymous build diagnostics are ON (this notice prints once).",
  "AfterPack: A build that reports an error-level diagnostic (a refused or partial build)",
  "AfterPack:   sends that diagnostic's code, severity, byte offsets and typed engine",
  "AfterPack:   fields, plus engine version, integration, Node version, OS/arch, bucketed",
  "AfterPack:   file counts and durations, and a random install id that rotates every 30",
  "AfterPack:   days.",
  "AfterPack: It never sends your source, file names, paths, project name, diagnostic",
  "AfterPack:   message text, or exact byte counts. A clean build sends nothing.",
  "AfterPack: Turn it off with AFTERPACK_telemetry_enabled=false, --telemetry.enabled=false, or",
  "AfterPack:   `telemetry: { enabled: false }` in your config.",
  "AfterPack: https://www.afterpack.dev/privacy",
];

const INSTALL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface TelemetryState {
  installId: string;
  rotatedAt: number;
  noticeShownAt: number;
}

export interface TelemetryReporterDeps {
  env?: EnvLike;
  logger?: NoticeLogger;
  fetchImpl?: typeof fetch;
  now?: () => number;
  stateFile?: string;
  timeoutMs?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function readState(file: string, now: number): TelemetryState {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<TelemetryState>;
    if (
      typeof parsed.installId === "string" &&
      INSTALL_ID_PATTERN.test(parsed.installId) &&
      typeof parsed.rotatedAt === "number"
    ) {
      return {
        installId: parsed.installId,
        rotatedAt: parsed.rotatedAt,
        noticeShownAt: typeof parsed.noticeShownAt === "number" ? parsed.noticeShownAt : 0,
      };
    }
  } catch {}
  return { installId: randomUUID(), rotatedAt: now, noticeShownAt: 0 };
}

function writeState(file: string, state: TelemetryState): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(state)}\n`, "utf8");
  } catch {}
}

function telemetryUrl(env: EnvLike): string {
  const base = (env[API_URL_ENV_VAR] ?? DEFAULT_API_URL).replace(/\/+$/, "");
  return `${base}${TELEMETRY_ENDPOINT_PATH}`;
}

const TELEMETRY_BODY_LIMIT = 64 * 1024;

async function reportTelemetryNotices(
  response: Response | undefined,
  logger: NoticeLogger,
): Promise<void> {
  if (!response || response.status !== 202 || typeof response.text !== "function") return;
  const text = await response.text();
  if (text.length > TELEMETRY_BODY_LIMIT) return;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return;
  reportNotices((body as { notices?: unknown }).notices, logger);
}

export function createTelemetryReporter(deps: TelemetryReporterDeps = {}): TelemetryReporter {
  const env = deps.env ?? (process.env as EnvLike);
  const logger = deps.logger ?? console;
  const now = deps.now ?? Date.now;
  const stateFile = deps.stateFile ?? TELEMETRY_STATE_FILE;
  const timeoutMs = deps.timeoutMs ?? TELEMETRY_TIMEOUT_MS;

  return async (facts: TelemetryFacts | null): Promise<void> => {
    try {
      const at = now();
      const state = readState(stateFile, at);
      let dirty = false;
      if (at - state.rotatedAt >= INSTALL_ID_ROTATION_DAYS * DAY_MS) {
        state.installId = randomUUID();
        state.rotatedAt = at;
        dirty = true;
      }
      if (state.noticeShownAt === 0) {
        for (const line of TELEMETRY_NOTICE) logger.log(line);
        state.noticeShownAt = at;
        dirty = true;
      }
      if (dirty) writeState(stateFile, state);

      if (facts === null) return;
      const payload = buildTelemetryPayload(facts, { installId: state.installId, env });
      if (payload === null) return;

      const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
      if (typeof fetchImpl !== "function") return;
      const response = await fetchImpl(telemetryUrl(env), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      await reportTelemetryNotices(response, logger);
    } catch {}
  };
}
