import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  type Dirent,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { stagedPath } from "./atomic-write.js";
import { AFTERPACK_DIR, isWithinDir } from "./home.js";
import type { RegionConfig } from "./policy.js";

export type HashTokenOf = (relativePath: string) => string | null;

export interface HashedNamesOptions {
  root: string;
  tokenOf: HashTokenOf;
  skip?: (relativePath: string) => boolean;
}

export interface HashedNameInput {
  source: string;
  regions?: RegionConfig[];
}

export interface HashedNameRewrite {
  to: string;
  text: string;
}

export interface HashedNamesPlan {
  tokens: Map<string, string>;
  renamed: Map<string, string>;
  rewrites: Map<string, HashedNameRewrite>;
  rewrite(text: string): string;
  preflight(): void;
  apply(): void;
}

const LOWER_HEX = "0123456789abcdef";
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const UPPER_ALNUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER_ALNUM = "0123456789abcdefghijklmnopqrstuvwxyz";
const ALNUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const MIN_TOKEN_LENGTH = 6;

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".bmp",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".wasm",
  ".gz",
  ".br",
  ".zst",
  ".zip",
  ".pdf",
  ".mp3",
  ".mp4",
  ".webm",
  ".ogg",
  ".wav",
  ".pack",
]);

function alphabetOf(token: string): string {
  if (/^[0-9a-f]+$/.test(token)) return LOWER_HEX;
  if (/^[A-Z2-7]+$/.test(token)) return BASE32;
  if (/^[0-9A-Z]+$/.test(token)) return UPPER_ALNUM;
  if (/^[0-9a-z~._-]+$/.test(token)) return LOWER_ALNUM;
  return ALNUM;
}

function regionsKey(regions: RegionConfig[] | undefined): string {
  return regions && regions.length > 0 ? JSON.stringify(regions) : "";
}

export function deriveHashToken(token: string, salt: string, regions = ""): string {
  const alphabet = alphabetOf(token);
  let out = "";
  for (let round = 0; out.length < token.length; round++) {
    const bytes = createHash("sha256").update(`${salt}\0${token}\0${regions}\0${round}`).digest();
    for (const byte of bytes) {
      if (out.length === token.length) break;
      out += alphabet[byte % alphabet.length];
    }
  }
  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenPattern(tokens: Iterable<string>): RegExp | null {
  const list = [...tokens].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  if (list.length === 0) return null;
  return new RegExp(`(?<![A-Za-z0-9])(?:${list.map(escapeRegExp).join("|")})(?![A-Za-z0-9])`, "g");
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

function readText(path: string): string | null {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    return null;
  }
  if (bytes.subarray(0, 8192).includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function listFiles(root: string, skip: (relativePath: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = toPosix(relative(root, full));
      if (entry.name === AFTERPACK_DIR || entry.name === "node_modules" || skip(rel)) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  walk(root);
  return out;
}

function isCandidate(path: string): boolean {
  const name = basename(path).toLowerCase();
  if (name.endsWith(".map")) return false;
  const dot = name.lastIndexOf(".");
  return dot < 0 || !BINARY_EXTENSIONS.has(name.slice(dot));
}

function tokenAt(root: string, tokenOf: HashTokenOf, path: string): string | null {
  const rel = toPosix(relative(root, path));
  if (rel.startsWith("..")) return null;
  const token = tokenOf(rel);
  if (token === null || token.length < MIN_TOKEN_LENGTH) return null;
  return basename(path).includes(token) ? token : null;
}

export function unreferencedHashedFiles(
  options: HashedNamesOptions,
  files: readonly string[],
): string[] {
  const owners = new Map<string, Set<string>>();
  for (const file of files) {
    const token = tokenAt(options.root, options.tokenOf, file);
    if (token !== null) owners.set(token, (owners.get(token) ?? new Set()).add(file));
  }
  const pattern = tokenPattern(owners.keys());
  if (pattern === null) return [];
  const referenced = new Set<string>();
  for (const path of listFiles(options.root, options.skip ?? (() => false))) {
    if (!isCandidate(path)) continue;
    const text = readText(path);
    if (text === null) continue;
    for (const [token] of text.matchAll(pattern)) {
      for (const owner of owners.get(token) ?? []) if (owner !== path) referenced.add(owner);
    }
  }
  return [...owners.values()]
    .flatMap((set) => [...set])
    .filter((file) => !referenced.has(file))
    .sort();
}

export interface TokenScanLimits {
  maxDepth: number;
  maxFiles: number;
  maxBytes: number;
}

export interface TokenScanResult {
  found: string | null;
  truncated: boolean;
}

export function findHashTokenReference(
  paths: readonly string[],
  options: HashedNamesOptions,
  files: readonly string[],
  limits: TokenScanLimits,
): TokenScanResult {
  const tokens = files
    .map((file) => tokenAt(options.root, options.tokenOf, file))
    .filter((token): token is string => token !== null);
  const pattern = tokenPattern(new Set(tokens));
  const result: TokenScanResult = { found: null, truncated: false };
  if (pattern === null) return result;
  let seenFiles = 0;
  let seenBytes = 0;
  const visit = (path: string, depth: number): void => {
    if (result.found !== null || result.truncated || isWithinDir(options.root, path)) return;
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(path);
    } catch {
      return;
    }
    if (stats.isDirectory()) {
      const name = basename(path);
      if (name === "node_modules" || name.startsWith(".")) return;
      if (depth > limits.maxDepth) {
        result.truncated = true;
        return;
      }
      for (const entry of readdirSync(path).sort()) visit(join(path, entry), depth + 1);
      return;
    }
    if (!stats.isFile() || !isCandidate(path)) return;
    seenFiles += 1;
    seenBytes += stats.size;
    if (seenFiles > limits.maxFiles || seenBytes > limits.maxBytes) {
      result.truncated = true;
      return;
    }
    const text = readText(path);
    pattern.lastIndex = 0;
    if (text !== null && pattern.test(text)) result.found = path;
  };
  for (const path of paths) visit(path, 0);
  return result;
}

function writableDir(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function planHashedNames(input: {
  options: HashedNamesOptions;
  inputs: ReadonlyMap<string, HashedNameInput>;
  salt: string;
}): HashedNamesPlan {
  const { root, tokenOf } = input.options;
  const skip = input.options.skip ?? (() => false);
  const tokens = new Map<string, string>();
  const tokenOfPath = (path: string): string | null => tokenAt(root, tokenOf, path);
  const addToken = (token: string, regions?: RegionConfig[]): boolean => {
    if (tokens.has(token)) return false;
    tokens.set(token, deriveHashToken(token, input.salt, regionsKey(regions)));
    return true;
  };

  for (const [path, { regions }] of input.inputs) {
    const token = tokenOfPath(path);
    if (token !== null) addToken(token, regions);
  }

  const others = new Map<string, string>();
  if (tokens.size > 0) {
    for (const path of listFiles(root, skip)) {
      if (input.inputs.has(path) || !isCandidate(path)) continue;
      const text = readText(path);
      if (text !== null) others.set(path, text);
    }
  }

  const changed = new Set<string>();
  let grew = tokens.size > 0;
  while (grew) {
    grew = false;
    const pattern = tokenPattern(tokens.keys());
    if (pattern === null) break;
    for (const [path, text] of others) {
      if (changed.has(path)) continue;
      pattern.lastIndex = 0;
      if (!pattern.test(text)) continue;
      changed.add(path);
      const token = tokenOfPath(path);
      if (token !== null && addToken(token)) grew = true;
    }
  }

  const pattern = tokenPattern(tokens.keys());
  const rewrite = (text: string): string =>
    pattern === null ? text : text.replace(pattern, (token) => tokens.get(token) ?? token);
  const renamedPath = (path: string): string => {
    const token = tokenOfPath(path);
    if (token === null || !tokens.has(token)) return path;
    const name = basename(path);
    const at = name.lastIndexOf(token);
    return join(
      dirname(path),
      `${name.slice(0, at)}${tokens.get(token)}${name.slice(at + token.length)}`,
    );
  };

  const renamed = new Map<string, string>();
  for (const path of input.inputs.keys()) {
    const next = renamedPath(path);
    if (next !== path) renamed.set(path, next);
  }
  const writes: { from: string; to: string; text: string }[] = [];
  const rewrites = new Map<string, HashedNameRewrite>();
  for (const path of changed) {
    const to = renamedPath(path);
    if (to !== path) renamed.set(path, to);
    const text = rewrite(others.get(path) as string);
    rewrites.set(path, { to, text });
    writes.push({ from: path, to, text });
  }

  const preflight = (): void => {
    const unwritable = new Set<string>();
    for (const [from, to] of renamed) {
      if (!writableDir(dirname(from))) unwritable.add(dirname(from));
      if (!writableDir(dirname(to))) unwritable.add(dirname(to));
    }
    for (const write of writes)
      if (!writableDir(dirname(write.to))) unwritable.add(dirname(write.to));
    if (unwritable.size > 0) {
      throw new Error(
        `cannot rename content-hashed files: these directories are not writable: ${[...unwritable]
          .sort()
          .join(", ")}`,
      );
    }
  };

  return {
    tokens,
    renamed,
    rewrites,
    rewrite,
    preflight,
    apply() {
      preflight();
      const staged: string[] = [];
      try {
        for (const write of writes) {
          writeFileSync(stagedPath(write.to), write.text);
          staged.push(stagedPath(write.to));
        }
      } catch (error) {
        for (const path of staged) rmSync(path, { force: true });
        throw error;
      }
      for (const write of writes) {
        renameSync(stagedPath(write.to), write.to);
        if (write.to !== write.from) rmSync(write.from, { force: true });
      }
    },
  };
}
