import { version } from "../../package.json";
import {
  bold,
  cyan,
  dim,
  green,
  header,
  red,
  severityColor,
  yellow,
} from "../utils/format.js";
import { streamSSE } from "../utils/sse.js";

const API_BASE = "https://api.afterpack.dev";
const WEB_BASE = "https://afterpack.dev";

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

function printUsage(): void {
  console.log(`
  ${bold("Usage:")} afterpack audit ${cyan("<url>")}

  Example: afterpack audit https://example.com
`);
  process.exit(1);
}

function normalizeUrl(input: string): string {
  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  // Validate
  try {
    new URL(url);
  } catch {
    console.error(`\n  ${red("Error:")} Invalid URL: ${input}\n`);
    process.exit(1);
  }
  return url;
}

function clearLine(): void {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[1A\x1b[2K");
  }
}

function printPhase(label: string, done: boolean): void {
  const icon = done ? green("✓") : yellow("●");
  console.log(`  ${icon} ${label}`);
}

function printSummaryBox(result: ScanResult): void {
  const lines: string[] = [];

  // Score
  if (result.score !== undefined) {
    const scoreColor =
      result.score >= 70 ? green : result.score >= 40 ? yellow : red;
    lines.push(`  Score: ${scoreColor(bold(`${result.score}/100`))}`);
    lines.push("");
  }

  // Resources
  if (result.resources) {
    const r = result.resources;
    const parts: string[] = [];
    if (r.unprotected) parts.push(`${r.unprotected} unprotected`);
    if (r.sourceExposed) parts.push(`${r.sourceExposed} source exposed`);
    const detail = parts.length > 0 ? ` (${parts.join(", ")})` : "";
    lines.push(`  Resources      ${r.total ?? 0} found${detail}`);
  }

  // Findings
  if (result.findings && result.findings.length > 0) {
    const counts: Record<string, number> = {};
    for (const f of result.findings) {
      const s = f.severity.toLowerCase();
      counts[s] = (counts[s] || 0) + 1;
    }
    const parts = Object.entries(counts).map(([sev, n]) => `${n} ${sev}`);
    lines.push(
      `  Findings       ${result.findings.length} issues (${parts.join(", ")})`,
    );
  }

  // Tech Stack
  if (result.techStack && result.techStack.length > 0) {
    lines.push(`  Tech Stack     ${result.techStack.join(", ")}`);
  }

  // Readability
  if (result.readability !== undefined) {
    lines.push(`  Readability    ${result.readability}/100`);
  }

  // Box
  const maxLen = Math.max(...lines.map((l) => stripAnsi(l).length), 50);
  const border = "─".repeat(maxLen + 4);

  console.log(`\n  ┌─${border}─┐`);
  for (const line of lines) {
    const pad = maxLen + 4 - stripAnsi(line).length;
    console.log(`  │ ${line}${" ".repeat(pad)} │`);
  }
  console.log(`  └─${border}─┘`);
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

export async function audit(url: string | undefined): Promise<void> {
  if (!url) {
    printUsage();
    return;
  }

  const normalizedUrl = normalizeUrl(url);

  console.log(header(version));
  console.log(`  Scanning ${cyan(normalizedUrl)} ...\n`);

  const phases = [
    "Fetching page",
    "Rendering JavaScript",
    "Analyzing resources",
  ];
  let currentPhaseIndex = -1;
  let extraLinesSincePhase = 0;
  const result: ScanResult = {};

  function advancePhase(phaseName?: string): void {
    // Mark current phase as done
    if (currentPhaseIndex >= 0) {
      if (extraLinesSincePhase === 0) {
        // No findings printed — replace ● with ✓ in place
        if (process.stdout.isTTY) clearLine();
        printPhase(phases[currentPhaseIndex], true);
      }
      // If findings were printed, the ● line stays — no ✓ needed
    }

    if (phaseName) {
      // Find phase index or add it
      let idx = phases.indexOf(phaseName);
      if (idx === -1) {
        phases.push(phaseName);
        idx = phases.length - 1;
      }
      currentPhaseIndex = idx;
      extraLinesSincePhase = 0;
      printPhase(phaseName, false);
    }
  }

  try {
    const stream = streamSSE(`${API_BASE}/v1/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: normalizedUrl }),
    });

    for await (const event of stream) {
      let payload: any;
      try {
        payload = JSON.parse(event.data);
      } catch {
        payload = event.data;
      }

      switch (event.event) {
        case "progress":
          advancePhase(payload.phase ?? payload.message);
          break;

        case "finding": {
          const finding: Finding = {
            severity: payload.severity ?? "info",
            title: payload.title ?? payload.message ?? "",
            detail: payload.detail,
          };
          if (!result.findings) result.findings = [];
          result.findings.push(finding);

          // Print critical/high findings immediately
          const sev = finding.severity.toLowerCase();
          if (sev === "critical" || sev === "high") {
            const color = severityColor(sev);
            console.log(
              `  ${color("⚠")}  ${color(finding.severity)}: ${finding.title}`,
            );
            extraLinesSincePhase++;
          }
          break;
        }

        case "score_update":
          result.score = payload.score ?? payload.value;
          break;

        case "complete":
          // Finalize current phase
          if (currentPhaseIndex >= 0 && extraLinesSincePhase === 0) {
            if (process.stdout.isTTY) clearLine();
            printPhase(phases[currentPhaseIndex], true);
          }

          // Merge final data
          if (payload.score !== undefined) result.score = payload.score;
          if (payload.id) result.id = payload.id;
          if (payload.resources) result.resources = payload.resources;
          if (payload.findings) result.findings = payload.findings;
          if (payload.techStack) result.techStack = payload.techStack;
          if (payload.readability !== undefined)
            result.readability = payload.readability;

          printSummaryBox(result);

          // Critical findings summary
          if (result.findings) {
            const critical = result.findings.filter(
              (f) => f.severity.toLowerCase() === "critical",
            );
            if (critical.length > 0) {
              console.log(
                `\n  ${red("⚠")}  ${bold(
                  `${critical.length} critical finding${
                    critical.length > 1 ? "s" : ""
                  }:`,
                )}`,
              );
              for (const f of critical) {
                console.log(
                  `     ${f.title}${f.detail ? ` (${dim(f.detail)})` : ""}`,
                );
              }
            }
          }

          // Report link
          if (result.id) {
            console.log(
              `\n  Full report: ${cyan(
                `${WEB_BASE}/security-scanner?id=${result.id}`,
              )}\n`,
            );
          } else {
            console.log("");
          }

          process.exit(0);

        case "error":
          console.error(
            `\n  ${red("Error:")} ${
              payload.message ?? payload.error ?? "Scan failed"
            }\n`,
          );
          process.exit(1);
      }
    }

    // If stream ends without a complete event, still show what we have
    if (result.score !== undefined) {
      printSummaryBox(result);
    }
    console.error(
      `\n  ${yellow("Warning:")} Stream ended without completion event.\n`,
    );
    process.exit(1);
  } catch (err: any) {
    console.error(
      `\n  ${red("Error:")} ${err.message ?? "Failed to connect to API"}\n`,
    );
    process.exit(1);
  }
}
