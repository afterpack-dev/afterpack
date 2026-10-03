import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SourceType } from "@afterpack/integration-utils";

const CLASSIC_SCRIPT_TYPES = new Set(["", "text/javascript", "application/javascript", "module"]);
const MAX_HTML_SCAN_DEPTH = 4;

export interface SourceTypeDetectionInput {
  files: readonly string[];
  buildDir: string;
}

function endsWith(file: string, extension: string): boolean {
  return file.toLowerCase().endsWith(extension);
}

function nearestPackageType(start: string): string | undefined {
  let dir = start;
  for (let i = 0; i < 64; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        type?: unknown;
      };
      if (typeof pkg.type === "string") return pkg.type;
      return undefined;
    } catch {}
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
  if (!match) return null;
  return match[2] ?? match[3] ?? match[4] ?? "";
}

export type HtmlScriptKinds = { module: boolean; classic: boolean };

export function htmlScriptKinds(html: string): HtmlScriptKinds {
  const kinds: HtmlScriptKinds = { module: false, classic: false };
  for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
    const tag = match[1];
    if (attribute(tag, "src") === null) continue;
    const type = (attribute(tag, "type") ?? "").trim().toLowerCase();
    if (type === "module") kinds.module = true;
    else if (CLASSIC_SCRIPT_TYPES.has(type)) kinds.classic = true;
  }
  return kinds;
}

function htmlFilesUnder(dir: string, depth: number): string[] {
  if (depth > MAX_HTML_SCAN_DEPTH) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry === "node_modules" || entry.codePointAt(0) === 0x2e) continue;
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) out.push(...htmlFilesUnder(full, depth + 1));
    else if (endsWith(entry, ".html") || endsWith(entry, ".htm")) out.push(full);
  }
  return out;
}

function scanBuiltHtml(buildDir: string): "module" | "mixed" | undefined {
  let sawModule = false;
  for (const file of htmlFilesUnder(buildDir, 0)) {
    let html: string;
    try {
      html = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const kinds = htmlScriptKinds(html);
    if (kinds.classic) return "mixed";
    if (kinds.module) sawModule = true;
  }
  return sawModule ? "module" : undefined;
}

export function detectCliSourceType(input: SourceTypeDetectionInput): SourceType | undefined {
  if (input.files.length === 0) return undefined;
  const hasCjs = input.files.some((file) => endsWith(file, ".cjs"));

  const html = scanBuiltHtml(input.buildDir);
  if (html === "mixed") return undefined;

  if (!hasCjs && nearestPackageType(input.buildDir) === "module") return "module";
  if (input.files.every((file) => endsWith(file, ".mjs"))) return "module";
  if (!hasCjs && html === "module") return "module";
  return undefined;
}
