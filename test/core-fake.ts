export interface EngineCall {
  input: string;
  configJson: string;
  inputSourceMap?: string;
  regions?: string;
}

export const engineCalls: EngineCall[] = [];

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
  impl = (input) => defaultResult(input);
}

export async function processBatch(
  files: Array<{ filePath: string; source: string; inputSourceMap?: string; regions?: string }>,
  configJson: string,
): Promise<{
  files: Array<{
    filePath: string;
    code: string;
    sourceMap?: string;
    protectionMap?: string;
    status: string;
    error?: string;
    unobfuscated?: boolean;
    diagnostics?: string;
  }>;
  totalFiles: number;
  successCount: number;
  failureCount: number;
  source: string;
}> {
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
  return {
    files: results,
    totalFiles: files.length,
    successCount,
    failureCount,
    source: "local",
  };
}

export async function version(): Promise<string> {
  return "0.0.0-test";
}
