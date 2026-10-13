import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { HashTokenOf } from "./hashed-names.js";

export const NEXT_CHUNKS_PREFIX = "static/chunks/";

const TURBOPACK_CHUNK_RE = /^(?:turbopack-)?([0-9a-z~._-]{13})\.(?:js|css)$/;
const WEBPACK_CHUNK_RE = /[-.]([0-9a-f]{16})\.js$/;
const ANGULAR_HASHED_NAME_RE = /-([A-Z0-9]{8})\.(?:js|mjs|css)$/;

export function detectNextBundler(distDir: string): string {
  if (existsSync(join(distDir, "turbopack"))) return "turbopack";
  if (existsSync(join(distDir, "server", "webpack-runtime.js"))) return "webpack";
  return "unknown";
}

export function nextChunkToken(bundler: string, chunksPrefix = NEXT_CHUNKS_PREFIX): HashTokenOf {
  const pattern =
    bundler === "turbopack" ? TURBOPACK_CHUNK_RE : bundler === "webpack" ? WEBPACK_CHUNK_RE : null;
  return (relativePath) => {
    if (pattern === null || !relativePath.startsWith(chunksPrefix)) return null;
    return pattern.exec(basename(relativePath))?.[1] ?? null;
  };
}

export function skipNextInternals(relativePath: string): boolean {
  return relativePath === "cache" || relativePath.startsWith("trace");
}

export const angularHashToken: HashTokenOf = (relativePath) =>
  ANGULAR_HASHED_NAME_RE.exec(basename(relativePath))?.[1] ?? null;
