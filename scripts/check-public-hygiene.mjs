#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAX_BYTES = 4 * 1024 * 1024;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".afterpack",
  ".vscode",
  ".next",
  ".next-webpack",
  ".output",
  ".nuxt",
  ".svelte-kit",
  ".angular",
  ".astro",
  ".parcel-cache",
  ".turbo",
  "build",
  "out",
]);
const LIFECYCLE = ["postinstall", "preinstall", "prepare", "install"];

const ABSOLUTE_PATH = [
  { re: /(?<![\w.-])\/Users\//, why: "absolute machine path" },
  { re: /(?<![\w.-])\/home\//, why: "absolute machine path" },
  { re: /(?<![\w.-])\/private\/tmp\b/, why: "absolute machine path" },
  { re: /(?<![\w.-])\/tmp\//, why: "absolute machine path" },
  { re: /(?<![\w.-])[A-Za-z]:\\/, why: "absolute machine path" },
];

const CREDENTIAL = [
  { re: /(?:^|[^\w-])registry(?:)=(\S*)/, why: "registry line with a literal value" },
  { re: /_auth(?:)Token\s*[=:]?\s*(\S*)/, why: "auth-token line with a literal value" },
];
const RESOLVED_AT_RUNTIME = /^(?:\$\{\{|\$\{?[A-Za-z_])/;

const FILE_SCHEME = /(?<![\w])fi(?:)le:([^\s"'`)<>]*)/g;
const TARBALL_KEY = /\btar(?:)ball:\s*(\S+)/;
const ESCAPE_CHAIN = /(?<![\w.-])((?:\.\.\/)+[^\s"'`)<>]*)/g;

const findings = [];

function report(file, line, message) {
  findings.push(`${file}:${line}: ${message}`);
}

function trim(line) {
  return line.trim().slice(0, 120);
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function trackedFiles() {
  return git(["ls-files", "-z"]).split("\0").filter(Boolean);
}

function isProbablyText(buffer) {
  const slice = buffer.subarray(0, 8192);
  for (const byte of slice) if (byte === 0) return false;
  return true;
}

function isInsideRoot(absPath) {
  const rel = path.relative(ROOT, absPath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isTestZone(relFile) {
  const base = path.basename(relFile).toLowerCase();
  if (/\.(test|spec)\./.test(base)) return true;
  if (/vectors?|fixtures?/.test(base)) return true;
  const segments = relFile.toLowerCase().split("/");
  return segments.some(
    (s) =>
      s === "tests" || s === "test" || s === "__tests__" || s === "fixtures" || s === "vectors",
  );
}

function isFullLineComment(line) {
  const t = line.trim();
  return t.startsWith("#") || t.startsWith("//") || t.startsWith("*");
}

function scanLine(relFile, dir, lineNo, line, skipAbsolute) {
  if (!skipAbsolute) {
    for (const { re, why } of ABSOLUTE_PATH) {
      if (re.test(line)) report(relFile, lineNo, `${why} — ${trim(line)}`);
    }
  }

  for (const { re, why } of CREDENTIAL) {
    const match = re.exec(line);
    if (!match) continue;
    const value = (match[1] ?? "").replace(/^["']/, "");
    if (value === "" || RESOLVED_AT_RUNTIME.test(value)) continue;
    report(relFile, lineNo, `${why} — ${trim(line)}`);
  }

  if (isFullLineComment(line)) return;
  for (const match of line.matchAll(FILE_SCHEME)) {
    const target = match[1];
    if (target === "" || target.startsWith("//")) continue;
    if (target.endsWith(".tgz")) {
      report(relFile, lineNo, `file: reference points at a packed tarball — ${trim(line)}`);
      continue;
    }
    if (!isInsideRoot(path.resolve(dir, target))) {
      report(
        relFile,
        lineNo,
        `file: reference resolves outside the repository root — ${trim(line)}`,
      );
    }
  }

  const tarball = TARBALL_KEY.exec(line);
  if (tarball) {
    report(
      relFile,
      lineNo,
      `lockfile resolution pins an explicit tarball reference — ${trim(line)}`,
    );
  }

  for (const match of line.matchAll(ESCAPE_CHAIN)) {
    if (!isInsideRoot(path.resolve(dir, match[1]))) {
      report(relFile, lineNo, `relative path escapes the repository root — ${trim(line)}`);
    }
  }
}

function scanFile(relFile, text) {
  const dir = path.dirname(path.join(ROOT, relFile));
  const skipAbsolute = isTestZone(relFile);
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    scanLine(relFile, dir, i + 1, lines[i], skipAbsolute);
  }
}

function scanPackageJson(relFile, text) {
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch {
    report(relFile, 1, "package.json is not valid JSON");
    return;
  }
  const scripts = pkg.scripts ?? {};
  for (const name of LIFECYCLE) {
    if (name in scripts) {
      const line = text.split("\n").findIndex((l) => l.includes(`"${name}"`)) + 1;
      report(
        relFile,
        line || 1,
        `lifecycle script "${name}" is not allowed in a published package`,
      );
    }
  }
}

function extraLockfiles(tracked) {
  const trackedSet = new Set(tracked);
  const found = [];
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (entry.name === "pnpm-lock.yaml" || entry.name === "package-lock.json") {
        const rel = path.relative(ROOT, abs).split(path.sep).join("/");
        if (!trackedSet.has(rel)) found.push(rel);
      }
    }
  }
  walk(ROOT);
  return found;
}

const tracked = trackedFiles();

for (const file of [...tracked, ...extraLockfiles(tracked)]) {
  if (path.basename(file) === ".npmrc") {
    if (tracked.includes(file)) {
      report(
        file,
        1,
        "a tracked .npmrc must never be committed — it is how a registry token leaks",
      );
    }
    continue;
  }
  const abs = path.join(ROOT, file);
  if (!existsSync(abs) || statSync(abs).size > MAX_BYTES) continue;
  const buffer = readFileSync(abs);
  if (!isProbablyText(buffer)) continue;
  const text = buffer.toString("utf8");
  scanFile(file, text);
  if (path.basename(file) === "package.json") scanPackageJson(file, text);
}

const rangeIndex = process.argv.indexOf("--range");
if (rangeIndex >= 0) {
  const range = process.argv[rangeIndex + 1];
  if (!range) {
    console.error("--range needs a revision range, e.g. --range main..HEAD");
    process.exit(2);
  }
  const log = git(["log", "--format=%H%x1f%B%x1e", range]);
  for (const entry of log.split("\x1e")) {
    const [sha, body] = entry.replace(/^\n/, "").split("\x1f");
    if (!sha || !body) continue;
    const lines = body.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const { re, why } of ABSOLUTE_PATH) {
        if (re.test(lines[i])) {
          report(`${sha.slice(0, 12)} (commit message)`, i + 1, `${why} — ${lines[i].trim()}`);
        }
      }
    }
  }
}

if (findings.length > 0) {
  console.error("repo hygiene check FAILED\n");
  for (const finding of findings) console.error(`  ${finding}`);
  console.error(`\n${findings.length} problem(s).`);
  process.exit(1);
}

console.log(`repo hygiene check passed (${tracked.length} tracked files)`);
