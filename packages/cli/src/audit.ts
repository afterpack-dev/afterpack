import { EXIT, type ExitCode } from "./exit.js";
import { bold, cyan, dim, green, header, red, severityColor, stripAnsi, yellow } from "./format.js";
import {
  emitJson,
  type JsonDiagnostic,
  jsonError,
  type OutputMode,
  sortDiagnostics,
} from "./output.js";
import type { CliLogger } from "./run.js";
import { type FetchLike, RateLimitedError, streamSSE } from "./sse.js";

export const AUDIT_USAGE = "usage: afterpack audit <url> [--diagnostics.format=text|json]";

export const AUDIT_HELP = `${AUDIT_USAGE}

Scans a DEPLOYED site for leaked secrets, exposed source and unprotected
JavaScript, and prints the findings as the scan streams. It reads no
configuration, writes no file, and sends nothing but the URL you give it.

Arguments:
  <url>                    the page to scan. A bare host is fine:
                           \`afterpack audit example.com\` scans https://example.com

Options:
  --diagnostics.format=<text|json>   json prints ONE document on stdout: the
                           findings, the score and the report link (default: text)
  --diagnostics.level=<summary|all|none>
                           none silences the progress phases (default: summary)
  --help, -h               this help

Environment:
  AFTERPACK_API_URL        the scanner endpoint (default https://api.afterpack.dev)
  NO_COLOR / FORCE_COLOR   turn ANSI off / on regardless of the terminal

Exit codes: 0 when the scan completed (findings and all — a finding is a
result, not a failure), 1 when the scan failed or the stream ended early,
64 when the URL is missing or malformed.`;

const DEFAULT_API_BASE = "https://api.afterpack.dev";
const WEB_BASE = "https://www.afterpack.dev";

interface Finding {
  severity: string;
  title: string;
  detail?: string;
}

interface ScanResult {
  id?: string;
  score?: number;
  resources?: { total?: number; unprotected?: number; sourceExposed?: number };
  findings?: Finding[];
  techStack?: string[];
  readability?: number;
}

export interface AuditDeps {
  positionals: string[];
  logger: CliLogger;
  report: CliLogger;
  env: Record<string, string | undefined>;
  mode: OutputMode;
  version: string;
  stdout: { isTTY: boolean; write(chunk: string): void };
  fetchImpl?: FetchLike;
}

function normalizeUrl(input: string): string | null {
  const raw = input.trim();
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function apiBase(env: Record<string, string | undefined>): string {
  const configured = env.AFTERPACK_API_URL?.trim();
  return (configured && configured.length > 0 ? configured : DEFAULT_API_BASE).replace(/\/+$/, "");
}

function formatRetry(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const rawMinutes = Math.floor((seconds % 3600) / 60);
  const minutes = hours === 0 ? Math.max(1, rawMinutes) : rawMinutes;
  return hours === 0 ? `${minutes}m` : `${hours}h ${minutes}m`;
}

function summaryLines(result: ScanResult): string[] {
  const lines: string[] = [];
  if (result.score !== undefined) {
    const tint = result.score >= 70 ? green : result.score >= 40 ? yellow : red;
    lines.push(`  Score: ${tint(bold(`${result.score}/100`))}`, "");
  }
  if (result.resources) {
    const r = result.resources;
    const parts: string[] = [];
    if (r.unprotected) parts.push(`${r.unprotected} unprotected`);
    if (r.sourceExposed) parts.push(`${r.sourceExposed} source exposed`);
    lines.push(
      `  Resources      ${r.total ?? 0} found${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`,
    );
  }
  if (result.findings && result.findings.length > 0) {
    const counts: Record<string, number> = {};
    for (const f of result.findings) {
      const s = f.severity.toLowerCase();
      counts[s] = (counts[s] ?? 0) + 1;
    }
    const parts = Object.entries(counts).map(([sev, n]) => `${n} ${sev}`);
    lines.push(`  Findings       ${result.findings.length} issues (${parts.join(", ")})`);
  }
  if (result.techStack && result.techStack.length > 0) {
    lines.push(`  Tech Stack     ${result.techStack.join(", ")}`);
  }
  if (result.readability !== undefined) {
    lines.push(`  Readability    ${result.readability}/100`);
  }
  return lines;
}

function printSummaryBox(report: CliLogger, result: ScanResult): void {
  const lines = summaryLines(result);
  if (lines.length === 0) return;
  const width = Math.max(...lines.map((l) => stripAnsi(l).length), 50);
  const border = "─".repeat(width + 4);
  report.log(`\n  ┌─${border}─┐`);
  for (const line of lines) {
    report.log(`  │ ${line}${" ".repeat(width + 4 - stripAnsi(line).length)} │`);
  }
  report.log(`  └─${border}─┘`);
}

function findingDiagnostics(findings: Finding[]): JsonDiagnostic[] {
  return findings.map((f) => ({
    code: "AUDIT_FINDING",
    level: f.severity.toLowerCase(),
    message: f.detail ? `${f.title} — ${f.detail}` : f.title,
  }));
}

function reportUrl(result: ScanResult): string | null {
  return result.id ? `${WEB_BASE}/security-scanner/${result.id}` : null;
}

function emitResult(deps: AuditDeps, url: string, result: ScanResult, code: ExitCode): void {
  const link = reportUrl(result);
  if (deps.mode.format === "json") {
    emitJson(deps.logger, {
      afterpack: deps.version,
      command: "audit",
      exitCode: code,
      ok: code === EXIT.ok,
      files: [],
      diagnostics: sortDiagnostics(findingDiagnostics(result.findings ?? [])),
      summary: {
        url,
        ...(result.id ? { scanId: result.id } : {}),
        ...(result.score !== undefined ? { score: result.score } : {}),
        ...(result.readability !== undefined ? { readability: result.readability } : {}),
        findings: result.findings?.length ?? 0,
        ...(result.resources ? { resources: result.resources } : {}),
        ...(result.techStack ? { techStack: [...result.techStack].sort() } : {}),
      },
      artifacts: link ? { report: link } : {},
    });
    return;
  }
  printSummaryBox(deps.report, result);
  const critical = (result.findings ?? []).filter((f) => f.severity.toLowerCase() === "critical");
  if (critical.length > 0) {
    deps.report.log(
      `\n  ${red("⚠")}  ${bold(`${critical.length} critical finding${critical.length > 1 ? "s" : ""}:`)}`,
    );
    for (const f of critical) {
      deps.report.log(`     ${f.title}${f.detail ? ` (${dim(f.detail)})` : ""}`);
    }
  }
  deps.report.log(link ? `\n  Full report: ${cyan(link)}\n` : "");
}

function fail(deps: AuditDeps, code: string, message: string, fix: string): ExitCode {
  if (deps.mode.format === "json") {
    emitJson(
      deps.logger,
      jsonError({
        version: deps.version,
        command: "audit",
        exitCode: EXIT.failure,
        code,
        message,
        fix,
      }),
    );
    return EXIT.failure;
  }
  deps.logger.error(`\n  ${red("Error:")} ${message}`);
  deps.logger.error(`  ${fix}\n`);
  return EXIT.failure;
}

function misuse(deps: AuditDeps, code: string, message: string): ExitCode {
  if (deps.mode.format === "json") {
    emitJson(
      deps.logger,
      jsonError({
        version: deps.version,
        command: "audit",
        exitCode: EXIT.usage,
        code,
        message,
        fix: AUDIT_USAGE,
      }),
    );
    return EXIT.usage;
  }
  deps.logger.error(`afterpack: ${message}`);
  deps.logger.error(AUDIT_USAGE);
  return EXIT.usage;
}

export async function audit(deps: AuditDeps): Promise<ExitCode> {
  if (deps.positionals.length === 0) return misuse(deps, "MISSING_URL", "audit needs a <url>");
  if (deps.positionals.length > 1) {
    return misuse(
      deps,
      "TOO_MANY_URLS",
      `audit takes a single <url>, got ${deps.positionals.length}`,
    );
  }
  const url = normalizeUrl(deps.positionals[0]);
  if (!url) return misuse(deps, "INVALID_URL", `not a URL: ${deps.positionals[0]}`);

  const interactive = deps.mode.format !== "json" && deps.stdout.isTTY;
  deps.report.log(header(deps.version));
  deps.report.log(`  Scanning ${cyan(url)} ...\n`);

  const phases = ["Fetching page", "Rendering JavaScript", "Analyzing resources"];
  let currentPhase = -1;
  let linesSincePhase = 0;
  const result: ScanResult = {};

  const printPhase = (label: string, done: boolean): void => {
    deps.report.log(`  ${done ? green("✓") : yellow("●")} ${label}`);
  };
  const finishPhase = (): void => {
    if (currentPhase < 0 || linesSincePhase > 0) return;
    if (interactive) deps.stdout.write("\x1b[1A\x1b[2K");
    printPhase(phases[currentPhase], true);
  };
  const advancePhase = (name?: string): void => {
    finishPhase();
    if (!name) return;
    let index = phases.indexOf(name);
    if (index === -1) index = phases.push(name) - 1;
    currentPhase = index;
    linesSincePhase = 0;
    printPhase(name, false);
  };

  try {
    const stream = streamSSE(
      `${apiBase(deps.env)}/v1/audit`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      },
      deps.fetchImpl,
    );

    for await (const event of stream) {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        payload = { message: event.data };
      }

      switch (event.event) {
        case "progress":
          advancePhase((payload.phase ?? payload.message) as string | undefined);
          break;

        case "finding": {
          const finding: Finding = {
            severity: (payload.severity as string) ?? "info",
            title: ((payload.title ?? payload.message) as string) ?? "",
            detail: payload.detail as string | undefined,
          };
          if (!result.findings) result.findings = [];
          result.findings.push(finding);
          const severity = finding.severity.toLowerCase();
          if (severity === "critical" || severity === "high") {
            const tint = severityColor(severity);
            deps.report.log(`  ${tint("⚠")}  ${tint(finding.severity)}: ${finding.title}`);
            linesSincePhase++;
          }
          break;
        }

        case "score_update":
          result.score = (payload.score ?? payload.value) as number | undefined;
          break;

        case "complete": {
          finishPhase();
          if (payload.score !== undefined) result.score = payload.score as number;
          if (payload.id) result.id = payload.id as string;
          if (payload.resources) result.resources = payload.resources as ScanResult["resources"];
          if (payload.findings) result.findings = payload.findings as Finding[];
          if (payload.techStack) result.techStack = payload.techStack as string[];
          if (payload.readability !== undefined) result.readability = payload.readability as number;
          emitResult(deps, url, result, EXIT.ok);
          return EXIT.ok;
        }

        case "error":
          return fail(
            deps,
            "SCAN_FAILED",
            ((payload.message ?? payload.error) as string) ?? "Scan failed",
            "Retry the scan; if it keeps failing the page may block automated fetches.",
          );
      }
    }

    return fail(
      deps,
      "STREAM_INCOMPLETE",
      "the scan stream ended without a completion event",
      "Retry the scan — a partial stream is a transport failure, not a verdict.",
    );
  } catch (error) {
    if (error instanceof RateLimitedError) {
      const limit = error.scansIn24h ?? 3;
      const seconds =
        error.retryAfterSeconds && Number.isFinite(error.retryAfterSeconds)
          ? Math.max(0, error.retryAfterSeconds)
          : 0;
      return fail(
        deps,
        "RATE_LIMITED",
        `daily scan limit reached — ${limit} scans / 24h for unregistered users`,
        seconds > 0
          ? `Try again in ${formatRetry(seconds)}, or sign in at ${WEB_BASE} for a higher limit.`
          : `Sign in at ${WEB_BASE} for a higher limit.`,
      );
    }
    return fail(
      deps,
      "REQUEST_FAILED",
      error instanceof Error ? error.message : String(error),
      `Check your network, or set AFTERPACK_API_URL if you reach the API through a proxy.`,
    );
  }
}
