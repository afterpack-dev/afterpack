import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { SourceType } from "@afterpack/integration-utils";

const CLASSIC_SCRIPT_TYPES = new Set([
  "",
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);
const MAX_HTML_SCAN_DEPTH = 4;

export interface SourceTypeDetectionInput {
  files: readonly string[];
  buildDir: string;
}

function endsWith(file: string, extension: string): boolean {
  return file.toLowerCase().endsWith(extension);
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(
    tag,
  );
  if (!match) return null;
  return match[2] ?? match[3] ?? match[4] ?? "";
}

export type HtmlScriptRefs = { module: string[]; classic: string[] };

export function htmlScriptRefs(html: string): HtmlScriptRefs {
  const refs: HtmlScriptRefs = { module: [], classic: [] };
  for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
    const tag = match[1];
    const src = attribute(tag, "src");
    if (src === null) continue;
    const type = (attribute(tag, "type") ?? "").trim().toLowerCase();
    if (type === "module") refs.module.push(src);
    else if (CLASSIC_SCRIPT_TYPES.has(type)) refs.classic.push(src);
  }
  return refs;
}

export type HtmlScriptKinds = { module: boolean; classic: boolean };

export function htmlScriptKinds(html: string): HtmlScriptKinds {
  const refs = htmlScriptRefs(html);
  return { module: refs.module.length > 0, classic: refs.classic.length > 0 };
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

function srcFileName(src: string): string {
  const path = src.split(/[?#]/)[0];
  return path.slice(path.lastIndexOf("/") + 1);
}

type BuiltHtmlRefs = { module: Set<string>; classic: Set<string> };

function scanBuiltHtml(buildDir: string): BuiltHtmlRefs | undefined {
  const module = new Set<string>();
  const classic = new Set<string>();
  let sawScript = false;
  for (const file of htmlFilesUnder(buildDir, 0)) {
    let html: string;
    try {
      html = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const refs = htmlScriptRefs(html);
    for (const src of refs.module) {
      module.add(srcFileName(src));
      sawScript = true;
    }
    for (const src of refs.classic) {
      classic.add(srcFileName(src));
      sawScript = true;
    }
  }
  return sawScript ? { module, classic } : undefined;
}

export function detectCliSourceType(input: SourceTypeDetectionInput): SourceType | undefined {
  if (input.files.length === 0) return undefined;

  if (input.files.every((file) => endsWith(file, ".mjs"))) return "module";

  const html = scanBuiltHtml(input.buildDir);
  if (html === undefined || html.classic.size > 0) return undefined;
  for (const file of input.files) {
    if (endsWith(file, ".mjs")) continue;
    if (!html.module.has(basename(file))) return undefined;
  }
  return "module";
}
