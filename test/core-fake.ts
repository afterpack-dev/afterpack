export interface EngineCall {
  input: string;
  configJson: string;
  inputSourceMap?: string;
  regions?: string;
}

export const engineCalls: EngineCall[] = [];

export const batchCalls: Array<{ configJson: string; buildContextJson?: string }> = [];

export interface FakeNotice {
  severity: string;
  code: string;
  message: string;
  url?: string;
}

export interface FakeFileResult {
  filePath: string;
  code: string;
  sourceMap?: string;
  protectionMap?: string;
  status: string;
  error?: string;
  unobfuscated?: boolean;
  diagnostics?: string;
}

export interface FakeBatchResult {
  files: FakeFileResult[];
  totalFiles: number;
  successCount: number;
  failureCount: number;
  source: string;
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

export function napiError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export function cloudErrorMessage(body: {
  code: string;
  message: string;
  details?: Record<string, unknown> | null;
  notices?: FakeNotice[] | null;
}): string {
  return JSON.stringify({
    code: body.code,
    message: body.message,
    details: body.details ?? null,
    notices: body.notices ?? null,
  });
}

export function asCloudBatch(result: FakeBatchResult): FakeBatchResult {
  return {
    ...result,
    source: "cloud",
    files: result.files.map((f) => {
      const diagnostics = JSON.parse(f.diagnostics ?? "[]") as Array<Record<string, unknown>>;
      const cloudDiagnostics = diagnostics.map((d) => ({
        code: d.code,
        severity: d.severity,
        message: d.message,
      }));
      const blocking = cloudDiagnostics.find(
        (d) => d.severity === "error" || d.severity === "critical",
      );
      return {
        ...f,
        diagnostics: JSON.stringify(cloudDiagnostics),
        ...(blocking ? { error: `${String(blocking.code)}: ${String(blocking.message)}` } : {}),
      };
    }),
  };
}

type ProcessImpl = (input: string, configJson: string) => string;

function defaultResult(input: string): string {
  return JSON.stringify({
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
  });
}

let impl: ProcessImpl = (input) => defaultResult(input);

export function __setProcessImpl(fn: ProcessImpl): void {
  impl = fn;
}

export function __setProcessResult(
  makeResult: (input: string, configJson: string) => Record<string, unknown>,
): void {
  impl = (input, configJson) => JSON.stringify(makeResult(input, configJson));
}

export function __reset(): void {
  engineCalls.length = 0;
  batchCalls.length = 0;
  decorate = null;
  batchError = null;
  impl = (input) => defaultResult(input);
}

export async function processBatch(
  files: Array<{ filePath: string; source: string; inputSourceMap?: string; regions?: string }>,
  configJson: string,
  buildContextJson?: string,
): Promise<FakeBatchResult> {
  batchCalls.push({ configJson, buildContextJson });
  if (batchError) throw batchError;
  let successCount = 0;
  let failureCount = 0;
  const results = files.map((f) => {
    engineCalls.push({
      input: f.source,
      configJson,
      inputSourceMap: f.inputSourceMap,
      regions: f.regions,
    });
    const pr = JSON.parse(impl(f.source, configJson)) as {
      code: string;
      sourceMap?: string | null;
      protectionMap?: unknown;
      unobfuscated?: boolean;
      diagnostics?: Array<Record<string, unknown> & { severity: string; message: string }>;
    };
    const fatal = pr.diagnostics?.find((d) => d.severity === "error" || d.severity === "critical");
    if (fatal) {
      failureCount++;
      return {
        filePath: f.filePath,
        code: "",
        status: "failure",
        error: fatal.message,
        diagnostics: JSON.stringify(pr.diagnostics ?? []),
      };
    }
    successCount++;
    return {
      filePath: f.filePath,
      code: pr.code,
      sourceMap: pr.sourceMap ?? undefined,
      protectionMap: pr.protectionMap != null ? JSON.stringify(pr.protectionMap) : undefined,
      status: "success",
      unobfuscated: pr.unobfuscated === true,
      diagnostics: JSON.stringify(pr.diagnostics ?? []),
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
