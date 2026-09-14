import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

const require = createRequire(path.join(repoRoot, "package.json"));
const ts = require("typescript");

const includePatterns = [
  "packages/*/src/**/*.{ts,mts,cts,js,mjs,cjs}",
  "packages/*/test/**/*.{ts,mts,cts,js,mjs,cjs}",
  "packages/*/vitest.config.ts",
  "packages/protection-map/*.{mjs,js}",
  "packages/*/e2e/**/*.spec.ts",
  "packages/*/e2e/**/*.mjs",
  "e2e/**/*.{ts,mjs}",
  "scripts/**/*.{ts,mjs}",
  "test/**/*.{ts,mts,cts,js,mjs,cjs}",
  "playwright.config.ts",
];

const excludePatterns = ["**/node_modules/**", "**/dist/**", "**/*.d.ts", "**/*.vectors.json"];

function globToRegExp(glob) {
  const specialChars = /[.+^${}()|[\]\\]/;
  let out = "";
  let i = 0;
  while (i < glob.length) {
    if (glob.startsWith("**/", i)) {
      out += "(?:.*/)?";
      i += 3;
      continue;
    }
    if (glob.startsWith("/**", i) && i + 3 === glob.length) {
      out += "(?:/.*)?";
      i += 3;
      continue;
    }
    const ch = glob[i];
    if (ch === "*") {
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "{") {
      const end = glob.indexOf("}", i);
      const options = glob
        .slice(i + 1, end)
        .split(",")
        .map((opt) => opt.replace(/[.+^${}()|[\]\\]/g, "\\$&"));
      out += `(?:${options.join("|")})`;
      i = end + 1;
      continue;
    }
    out += specialChars.test(ch) ? `\\${ch}` : ch;
    i += 1;
  }
  return new RegExp(`^${out}$`);
}

const includeRegExps = includePatterns.map(globToRegExp);
const excludeRegExps = excludePatterns.map(globToRegExp);

function isTargetFile(relPath) {
  if (!includeRegExps.some((re) => re.test(relPath))) return false;
  if (excludeRegExps.some((re) => re.test(relPath))) return false;
  return true;
}

function listTrackedFiles() {
  return execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

function buildLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function lineForPos(lineStarts, pos) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function isAllowedComment(raw, kind) {
  if (kind === ts.SyntaxKind.MultiLineCommentTrivia) return false;
  if (raw.startsWith("///")) {
    return raw.slice(3).trim().startsWith("<reference");
  }
  const body = raw.slice(2).trim();
  if (/^biome-ignore(?:-all|-start|-end)?(?=\s|$)/.test(body)) return true;
  const match = body.match(/^@ts-expect-error\b([\s\S]*)$/);
  if (match) {
    const reason = match[1].replace(/^[\s:-]+/, "").trim();
    return reason.length > 0;
  }
  return false;
}

function collectCommentRanges(sourceFile, text) {
  const ranges = new Map();
  function visit(node) {
    const leading = ts.getLeadingCommentRanges(text, node.getFullStart()) || [];
    for (const range of leading) ranges.set(`${range.pos}:${range.end}`, range);
    const trailing = ts.getTrailingCommentRanges(text, node.end) || [];
    for (const range of trailing) ranges.set(`${range.pos}:${range.end}`, range);
    for (const child of node.getChildren(sourceFile)) visit(child);
  }
  visit(sourceFile);
  return [...ranges.values()].sort((a, b) => a.pos - b.pos);
}

function scriptKindFor(relPath) {
  if (relPath.endsWith(".ts") || relPath.endsWith(".mts") || relPath.endsWith(".cts")) {
    return ts.ScriptKind.TS;
  }
  return ts.ScriptKind.JS;
}

function snippetFor(raw) {
  return raw.replace(/\s+/g, " ").trim().slice(0, 80);
}

const listMode = process.argv.includes("--list");

const targetFiles = listTrackedFiles().filter(isTargetFile).sort();

const violations = [];
const listed = [];
let commentTotal = 0;

for (const relPath of targetFiles) {
  const absPath = path.join(repoRoot, relPath);
  if (!fs.existsSync(absPath)) continue;
  const text = fs.readFileSync(absPath, "utf8");
  const lineStarts = buildLineStarts(text);
  const sourceFile = ts.createSourceFile(
    relPath,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(relPath),
  );
  const ranges = collectCommentRanges(sourceFile, text);
  for (const range of ranges) {
    commentTotal += 1;
    const raw = text.slice(range.pos, range.end);
    const line = lineForPos(lineStarts, range.pos);
    if (listMode) {
      listed.push(`${relPath}:${line}: ${snippetFor(raw)}`);
      continue;
    }
    if (!isAllowedComment(raw, range.kind)) {
      violations.push(`${relPath}:${line}: ${snippetFor(raw)}`);
    }
  }
}

if (listMode) {
  for (const line of listed) console.log(line);
  console.log(`Listed ${listed.length} comment(s) across ${targetFiles.length} file(s).`);
  process.exit(0);
}

if (violations.length > 0) {
  for (const line of violations) console.log(line);
  console.log(
    `${violations.length} disallowed comment(s) found across ${targetFiles.length} file(s) scanned.`,
  );
  process.exit(1);
}

console.log(
  `No disallowed comments found (${targetFiles.length} file(s) scanned, ${commentTotal} comment(s) total).`,
);
process.exit(0);
