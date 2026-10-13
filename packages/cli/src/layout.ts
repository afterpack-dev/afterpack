import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, posix, relative, sep } from "node:path";
import {
  angularHashToken,
  angularServerManifestRefusal,
  detectNextBundler,
  type HashedNamesOptions,
  type HashTokenOf,
  NEXT_CHUNKS_PREFIX,
  nextChunkToken,
  skipNextInternals,
  unreferencedHashedFiles,
} from "@afterpack/integration-utils";

export type LayoutKind = "next" | "next-export" | "angular" | "vite" | "webpack";

export interface HashedLayout {
  kind: LayoutKind;
  hashedNames: HashedNamesOptions;
  angular?: { outputRoot: string; browserDir: string };
}

export type LayoutDecision =
  | { status: "rename"; layout: HashedLayout }
  | { status: "keep" }
  | { status: "refuse"; message: string }
  | { status: "plain" };

export const KEPT_NAMES_NOTICE =
  "File names stay as your bundler hashed them, so a cache can serve an old copy under the " +
  "same name. For long-lived caching, use your framework's AfterPack plugin, or pin a constant " +
  "`seed`.";

const NEXT_EXPORT_CHUNKS_PREFIX = `_next/${NEXT_CHUNKS_PREFIX}`;
const VITE_HASHED_NAME_RE = /-([A-Za-z0-9_-]{8})\.(?:js|mjs|css)$/;
const WEBPACK_HASHED_NAME_RE = /[.-]([0-9a-f]{8,64})\.(?:js|mjs|css)$/;
const WEBPACK_RUNTIME_RE = /webpackChunk|webpackJsonp|__webpack_require__/;
const TURBOPACK_NAME_RE = /^(?:turbopack-)?[0-9a-z~._-]{13}\.js$/;
const GENERIC_HASHED_NAME_RE = /[.-]([A-Za-z0-9_-]{8,})\.[cm]?js$/;
const BARE_HASH_NAME_RE = /^([A-Za-z0-9_-]{8,})\.[cm]?js$/;
const ANGULAR_MAIN_RE = /^main-[A-Z0-9]{8}\.js$/;
const REFERENCE_RE = /\b(?:src|href)\s*=\s*["']([^"'#?]+)/g;

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function namesIn(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

function hashLike(token: string): boolean {
  return /[0-9]/.test(token) || (/[a-z]/.test(token) && /[A-Z]/.test(token));
}

function hasDigitAndLetter(token: string): boolean {
  return /[0-9]/.test(token) && /[A-Za-z]/.test(token);
}

export function looksContentHashed(files: readonly string[]): boolean {
  return files.some((file) => {
    const name = basename(file);
    if (TURBOPACK_NAME_RE.test(name) && hasDigitAndLetter(name.slice(0, -3))) return true;
    const bare = BARE_HASH_NAME_RE.exec(name)?.[1];
    if (bare !== undefined && /[0-9]/.test(bare) && /[a-z]/.test(bare) && /[A-Z]/.test(bare)) {
      return true;
    }
    const token = GENERIC_HASHED_NAME_RE.exec(name)?.[1];
    return token !== undefined && hasDigitAndLetter(token);
  });
}

function isNextDistDir(dir: string): boolean {
  return existsSync(join(dir, "BUILD_ID")) && isDir(join(dir, "static", "chunks"));
}

function inferNextBundler(chunksDir: string): string {
  const names = namesIn(chunksDir);
  if (names.some((name) => /^turbopack-.*\.js$/.test(name))) return "turbopack";
  if (names.some((name) => /^webpack-[0-9a-f]{16}\.js$/.test(name))) return "webpack";
  return "unknown";
}

function nextLayout(target: string): LayoutDecision | null {
  for (const distDir of [target, dirname(target), dirname(dirname(target))]) {
    const rel = toPosix(relative(distDir, target));
    if (!["", "static", "static/chunks"].includes(rel) || !isNextDistDir(distDir)) continue;
    let bundler = detectNextBundler(distDir);
    if (bundler === "unknown") bundler = inferNextBundler(join(distDir, "static", "chunks"));
    if (bundler === "unknown") return { status: "keep" };
    return {
      status: "rename",
      layout: {
        kind: "next",
        hashedNames: { root: distDir, tokenOf: nextChunkToken(bundler), skip: skipNextInternals },
      },
    };
  }
  return null;
}

function nextExportLayout(target: string): LayoutDecision | null {
  const chunksDir = join(target, "_next", "static", "chunks");
  if (!isDir(chunksDir) || !namesIn(target).some((name) => name.endsWith(".html"))) return null;
  const sibling = join(dirname(target), ".next");
  let bundler = isNextDistDir(sibling) ? detectNextBundler(sibling) : "unknown";
  if (bundler === "unknown") bundler = inferNextBundler(chunksDir);
  if (bundler === "unknown") return { status: "keep" };
  return {
    status: "rename",
    layout: {
      kind: "next-export",
      hashedNames: { root: target, tokenOf: nextChunkToken(bundler, NEXT_EXPORT_CHUNKS_PREFIX) },
    },
  };
}

function isAngularBrowserDir(dir: string): boolean {
  const names = namesIn(dir);
  return (
    (names.includes("index.html") || names.includes("index.csr.html")) &&
    names.some((name) => ANGULAR_MAIN_RE.test(name))
  );
}

function angularLayout(target: string): LayoutDecision | null {
  const [outputRoot, browserDir] =
    basename(target) === "browser" ? [dirname(target), target] : [target, join(target, "browser")];
  if (!isAngularBrowserDir(browserDir)) return null;
  const refusal = angularServerManifestRefusal(outputRoot);
  if (refusal !== null) return { status: "refuse", message: refusal };
  return {
    status: "rename",
    layout: {
      kind: "angular",
      hashedNames: { root: outputRoot, tokenOf: angularHashToken },
      angular: { outputRoot, browserDir },
    },
  };
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function existingSuffix(root: string, ref: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//")) return null;
  const parts = ref.split("/").filter((part) => part !== "" && part !== ".");
  for (let i = 0; i < parts.length; i++) {
    const rest = parts.slice(i).join("/");
    if (existsSync(join(root, rest))) return rest;
  }
  return null;
}

function viteHashedDirs(target: string): Set<string> | null {
  const html = join(target, "index.html");
  const manifest = join(target, ".vite", "manifest.json");
  if (!existsSync(html) && !existsSync(manifest)) return null;
  const dirs = new Set<string>();
  const parsed = readJson(manifest);
  if (parsed !== null && typeof parsed === "object") {
    for (const entry of Object.values(parsed as Record<string, unknown>)) {
      const file = (entry as { file?: unknown } | null)?.file;
      if (typeof file === "string") dirs.add(posix.dirname(file));
    }
  }
  if (existsSync(html)) {
    for (const [, ref] of readFileSync(html, "utf8").matchAll(REFERENCE_RE)) {
      const rest = existingSuffix(target, ref);
      if (rest !== null && VITE_HASHED_NAME_RE.test(rest)) dirs.add(posix.dirname(rest));
    }
  }
  if (dirs.size === 0) dirs.add("assets");
  return dirs;
}

function viteToken(dirs: Set<string>): HashTokenOf {
  return (relativePath) => {
    if (!dirs.has(posix.dirname(relativePath))) return null;
    const token = VITE_HASHED_NAME_RE.exec(basename(relativePath))?.[1] ?? null;
    return token !== null && hashLike(token) ? token : null;
  };
}

const webpackToken: HashTokenOf = (relativePath) => {
  const token = WEBPACK_HASHED_NAME_RE.exec(basename(relativePath))?.[1] ?? null;
  return token !== null && /[a-f]/.test(token) ? token : null;
};

function selfContained(
  kind: LayoutKind,
  hashedNames: HashedNamesOptions,
  files: readonly string[],
): LayoutDecision {
  if (unreferencedHashedFiles(hashedNames, files).length > 0) return { status: "keep" };
  return { status: "rename", layout: { kind, hashedNames } };
}

function hasToken(tokenOf: HashTokenOf, root: string, files: readonly string[]): boolean {
  return files.some((file) => tokenOf(toPosix(relative(root, file))) !== null);
}

function viteLayout(target: string, files: readonly string[]): LayoutDecision | null {
  const dirs = viteHashedDirs(target);
  if (dirs === null) return null;
  const tokenOf = viteToken(dirs);
  if (!hasToken(tokenOf, target, files)) return null;
  const ambiguous = files.some((file) => {
    const rel = toPosix(relative(target, file));
    return dirs.has(posix.dirname(rel)) && VITE_HASHED_NAME_RE.test(rel) && tokenOf(rel) === null;
  });
  if (ambiguous) return { status: "keep" };
  return selfContained("vite", { root: target, tokenOf }, files);
}

function readsWebpackRuntime(files: readonly string[]): boolean {
  return files.some((file) => {
    try {
      return WEBPACK_RUNTIME_RE.test(readFileSync(file, "utf8"));
    } catch {
      return false;
    }
  });
}

function webpackLayout(target: string, files: readonly string[]): LayoutDecision | null {
  const hashed = files.filter((file) => WEBPACK_HASHED_NAME_RE.test(basename(file)));
  if (hashed.length === 0 || !readsWebpackRuntime(files)) return null;
  if (hashed.some((file) => webpackToken(basename(file)) === null)) return { status: "keep" };
  return selfContained("webpack", { root: target, tokenOf: webpackToken }, files);
}

export function detectHashedLayout(
  target: string,
  isDirectory: boolean,
  files: readonly string[],
): LayoutDecision {
  const decision = isDirectory
    ? (nextLayout(target) ??
      nextExportLayout(target) ??
      angularLayout(target) ??
      viteLayout(target, files) ??
      webpackLayout(target, files))
    : null;
  if (decision !== null) return decision;
  return looksContentHashed(files) ? { status: "keep" } : { status: "plain" };
}

export function angularIntegrityTargets(browserDir: string): string[] {
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
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".html")) out.push(full);
    }
  };
  walk(browserDir);
  const ngsw = join(browserDir, "ngsw.json");
  if (existsSync(ngsw)) out.push(ngsw);
  return out.sort();
}
