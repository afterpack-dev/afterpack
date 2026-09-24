import type { ProtectionMap } from "../packages/protection-map/index.js";

export interface EngineCall {
  input: string;
  config: Record<string, unknown>;
  sourceMap?: string;
  regions?: unknown[];
}

export const engineCalls: EngineCall[] = [];

export const batchCalls: Array<{
  config: Record<string, unknown>;
  buildContext?: Record<string, unknown>;
}> = [];

export interface FakeNotice {
  severity: string;
  code: string;
  message: string;
  url?: string;
}

export interface FakeDiagnosticData {
  kind: string;
  [key: string]: unknown;
}

export interface FakeDiagnostic {
  severity: "info" | "error" | "critical";
  code: string;
  message: string;
  file?: string | null;
  span?: { startByte: number; endByte: number } | null;
  data?: FakeDiagnosticData | null;
}

export interface FakeFileResult {
  path: string;
  code: string;
  sourceMap?: string;
  protectionMap?: ProtectionMap;
  status: "success" | "failure";
  error?: string;
  unobfuscated: boolean;
  diagnostics?: FakeDiagnostic[];
}

export interface FakeBatchResult {
  files: FakeFileResult[];
  totalFiles: number;
  successCount: number;
  failureCount: number;
  source: "local" | "cloud";
  notices?: FakeNotice[];
  engineVersion?: string;
}

type BatchDecorator = (result: FakeBatchResult) => FakeBatchResult;

let decorate: BatchDecorator | null = null;

let batchError: Error | null = null;

export function __setBatchDecorator(fn: BatchDecorator): void {
  decorate = fn;
}

export function __setBatchError(error: Error): void {
  batchError = error;
}

export type FakeCloudErrorCode =
  | "AFTERPACK_CLOUD_UPGRADE_REQUIRED"
  | "AFTERPACK_CLOUD_SUNSET"
  | "AFTERPACK_CLOUD_API";

export class ObfuscationError extends Error {
  readonly diagnostics: FakeDiagnostic[];
  readonly code?: FakeCloudErrorCode;
  readonly details?: Record<string, unknown> | null;
  readonly notices?: FakeNotice[] | null;

  constructor(
    message: string,
    diagnostics: FakeDiagnostic[],
    cloud?: {
      code: FakeCloudErrorCode;
      details: Record<string, unknown> | null;
      notices: FakeNotice[] | null;
    },
  ) {
    super(message);
    this.name = "ObfuscationError";
    this.diagnostics = diagnostics;
    if (cloud !== undefined) {
      this.code = cloud.code;
      this.details = cloud.details;
      this.notices = cloud.notices;
    }
  }
}

export function cloudRefusal(
  code: FakeCloudErrorCode,
  body: {
    message: string;
    apiCode?: string;
    details?: Record<string, unknown> | null;
    notices?: FakeNotice[] | null;
  },
): ObfuscationError {
  const diagnostics: FakeDiagnostic[] =
    body.apiCode === undefined
      ? []
      : [{ severity: "error", code: body.apiCode, message: body.message, file: null, span: null }];
  return new ObfuscationError(body.message, diagnostics, {
    code,
    details: body.details ?? null,
    notices: body.notices ?? null,
  });
}

export function asCloudBatch(result: FakeBatchResult): FakeBatchResult {
  return {
    ...result,
    source: "cloud",
    files: result.files.map((f) => {
      const diagnostics = f.diagnostics ?? [];
      const cloudDiagnostics = diagnostics.map((d) => ({
        code: d.code,
        severity: d.severity,
        message: d.message,
        file: null,
        span: null,
      }));
      const blocking = cloudDiagnostics.find(
        (d) => d.severity === "error" || d.severity === "critical",
      );
      return {
        ...f,
        diagnostics: cloudDiagnostics,
        ...(blocking ? { error: `${String(blocking.code)}: ${String(blocking.message)}` } : {}),
      };
    }),
  };
}

type ProcessImpl = (input: string, config: Record<string, unknown>) => Record<string, unknown>;

function defaultResult(input: string): Record<string, unknown> {
  return {
    code: input,
    sourceMap: null,
    coverage: {},
    complexityScore: 0,
    diagnostics: [],
    protectionMap: null,
    leaks: {
      leakCount: 0,
      leakBytes: 0,
      acceptedResidualCount: 0,
      propertyNameCount: 0,
      truncated: false,
      literals: [],
    },
    advisory: [],
  };
}

let impl: ProcessImpl = (input) => defaultResult(input);

export function __setProcessImpl(fn: ProcessImpl): void {
  impl = fn;
}

export function __setProcessResult(
  makeResult: (input: string, config: Record<string, unknown>) => Record<string, unknown>,
): void {
  impl = (input, config) => makeResult(input, config);
}

export function __reset(): void {
  engineCalls.length = 0;
  batchCalls.length = 0;
  decorate = null;
  batchError = null;
  impl = (input) => defaultResult(input);
}

export async function processBatch(
  files: Array<{ path: string; source: string; sourceMap?: string; regions?: unknown[] }>,
  config: unknown,
  buildContext?: unknown,
): Promise<FakeBatchResult> {
  const configRecord = (config ?? {}) as Record<string, unknown>;
  const buildContextRecord = (buildContext ?? undefined) as Record<string, unknown> | undefined;
  batchCalls.push({ config: configRecord, buildContext: buildContextRecord });
  if (batchError) throw batchError;
  let successCount = 0;
  let failureCount = 0;
  const results = files.map((f) => {
    engineCalls.push({
      input: f.source,
      config: configRecord,
      sourceMap: f.sourceMap,
      regions: f.regions,
    });
    const pr = impl(f.source, configRecord) as {
      code: string;
      sourceMap?: string | null;
      protectionMap?: ProtectionMap | null;
      unobfuscated?: boolean;
      diagnostics?: FakeDiagnostic[];
    };
    const fatal = pr.diagnostics?.find((d) => d.severity === "error" || d.severity === "critical");
    if (fatal) {
      failureCount++;
      return {
        path: f.path,
        code: "",
        status: "failure" as const,
        error: fatal.message,
        unobfuscated: false,
        diagnostics: pr.diagnostics ?? [],
      };
    }
    successCount++;
    return {
      path: f.path,
      code: pr.code,
      sourceMap: pr.sourceMap ?? undefined,
      protectionMap: pr.protectionMap ?? undefined,
      status: "success" as const,
      unobfuscated: pr.unobfuscated === true,
      diagnostics: pr.diagnostics ?? [],
    };
  });
  const result: FakeBatchResult = {
    files: results,
    totalFiles: files.length,
    successCount,
    failureCount,
    source: "local",
  };
  return decorate ? decorate(result) : result;
}

export async function version(): Promise<string> {
  return "0.0.0-test";
}
