import { createHash } from "node:crypto";
import { type Dirent, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { AFTERPACK_DIR } from "./home.js";

export type HashTokenOf = (relativePath: string) => string | null;

export interface HashedNamesOptions {
  root: string;
  tokenOf: HashTokenOf;
  skip?: (relativePath: string) => boolean;
}

export interface HashedNamesPlan {
  tokens: Map<string, string>;
  renamed: Map<string, string>;
  rewrite(text: string): string;
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

export function deriveHashToken(token: string, salt: string): string {
  const alphabet = alphabetOf(token);
  let out = "";
  for (let round = 0; out.length < token.length; round++) {
    const bytes = createHash("sha256").update(`${salt}\0${token}\0${round}`).digest();
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

export function planHashedNames(input: {
  options: HashedNamesOptions;
  inputs: ReadonlyMap<string, string>;
  salt: string;
}): HashedNamesPlan {
  const { root, tokenOf } = input.options;
  const skip = input.options.skip ?? (() => false);
  const tokens = new Map<string, string>();
  const tokenOfPath = (path: string): string | null => {
    const rel = toPosix(relative(root, path));
    if (rel.startsWith("..")) return null;
    const token = tokenOf(rel);
    if (token === null || token.length < MIN_TOKEN_LENGTH) return null;
    return basename(path).includes(token) ? token : null;
  };
  const addToken = (token: string): boolean => {
    if (tokens.has(token)) return false;
    tokens.set(token, deriveHashToken(token, input.salt));
    return true;
  };

  for (const path of input.inputs.keys()) {
    const token = tokenOfPath(path);
    if (token !== null) addToken(token);
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
  for (const path of changed) {
    const to = renamedPath(path);
    if (to !== path) renamed.set(path, to);
    writes.push({ from: path, to, text: rewrite(others.get(path) as string) });
  }

  return {
    tokens,
    renamed,
    rewrite,
    apply() {
      for (const write of writes) {
        writeFileSync(write.from, write.text);
        if (write.to !== write.from) renameSync(write.from, write.to);
      }
    },
  };
}
