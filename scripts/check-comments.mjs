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
  "packages/protection-map/*.html",
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

function findCssCommentRanges(text, offset) {
  const ranges = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const quote = c;
      i += 1;
      while (i < n && text[i] !== quote) i += text[i] === "\\" ? 2 : 1;
      i += 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      const end = Math.min(i + 2, n);
      ranges.push({
        pos: offset + start,
        end: offset + end,
        kind: ts.SyntaxKind.MultiLineCommentTrivia,
      });
      i = end;
      continue;
    }
    i += 1;
  }
  return ranges;
}

function findHtmlCommentRanges(text, offset) {
  const ranges = [];
  let i = 0;
  while (true) {
    const start = text.indexOf("<!--", i);
    if (start === -1) break;
    const end = text.indexOf("-->", start + 4);
    if (end === -1) break;
    ranges.push({
      pos: offset + start,
      end: offset + end + 3,
      kind: ts.SyntaxKind.MultiLineCommentTrivia,
    });
    i = end + 3;
  }
  return ranges;
}

function findJsCommentRanges(text, offset) {
  const sourceFile = ts.createSourceFile(
    "inline.js",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  return collectCommentRanges(sourceFile, text).map((range) => ({
    pos: offset + range.pos,
    end: offset + range.end,
    kind: range.kind,
  }));
}

const HTML_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style>|<script\b[^>]*>([\s\S]*?)<\/script>/gi;

function collectHtmlFileRanges(text) {
  const ranges = [];
  let cursor = 0;
  let match = HTML_BLOCK_RE.exec(text);
  while (match !== null) {
    ranges.push(...findHtmlCommentRanges(text.slice(cursor, match.index), cursor));
    const isStyle = match[1] !== undefined;
    const inner = isStyle ? match[1] : match[2];
    const innerStart = match.index + match[0].indexOf(">") + 1;
    ranges.push(
      ...(isStyle
        ? findCssCommentRanges(inner, innerStart)
        : findJsCommentRanges(inner, innerStart)),
    );
    cursor = match.index + match[0].length;
    match = HTML_BLOCK_RE.exec(text);
  }
  ranges.push(...findHtmlCommentRanges(text.slice(cursor), cursor));
  return ranges.sort((a, b) => a.pos - b.pos);
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
  let ranges;
  if (relPath.endsWith(".html")) {
    ranges = collectHtmlFileRanges(text);
  } else {
    const sourceFile = ts.createSourceFile(
      relPath,
      text,
      ts.ScriptTarget.Latest,
      true,
      scriptKindFor(relPath),
    );
    ranges = collectCommentRanges(sourceFile, text);
  }
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
