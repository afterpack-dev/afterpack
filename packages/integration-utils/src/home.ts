import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const AFTERPACK_DIR = ".afterpack";

const STRONG_MARKERS = [
  "afterpack.json",
  ".git",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
] as const;

const WEAK_MARKERS = ["package.json"] as const;

export const DIAG_AFTERPACK_DIR_IN_OUTPUT = "DIAG_AFTERPACK_DIR_IN_OUTPUT";

export const DIAG_RECEIPT_UNWRITABLE = "DIAG_RECEIPT_UNWRITABLE";

export class AfterpackFilesError extends Error {
  readonly code: string;
  readonly summary: string;
  readonly fix: string;

  constructor(code: string, summary: string, fix: string) {
    super(`${summary} ${fix}`);
    this.name = "AfterpackFilesError";
    this.code = code;
    this.summary = summary;
    this.fix = fix;
  }
}

export interface AfterpackHome {
  dir: string;
  projectRoot: string;
  marker: string | null;
  strong: boolean;
  buildDir: string;
}

export function realPath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync.native(resolved);
  } catch {
    const parent = dirname(resolved);
    return parent === resolved ? resolved : join(realPath(parent), basename(resolved));
  }
}

export function isWithinDir(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export interface AfterpackHomeOptions {
  fileTarget?: boolean;
}

function markerIn(dir: string, markers: readonly string[]): string | null {
  return markers.find((name) => existsSync(join(dir, name))) ?? null;
}

function nearestMarker(
  start: string,
  markers: readonly string[],
): { root: string; marker: string } | null {
  for (let current = start; ; ) {
    const marker = markerIn(current, markers);
    if (marker) return { root: current, marker };
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function afterpackHome(buildDir: string, options: AfterpackHomeOptions = {}): AfterpackHome {
  const realBuildDir = realPath(buildDir);
  const ownMarker = options.fileTarget ? markerIn(realBuildDir, STRONG_MARKERS) : null;
  if (ownMarker !== null) {
    return {
      dir: join(realBuildDir, AFTERPACK_DIR),
      projectRoot: realBuildDir,
      marker: ownMarker,
      strong: true,
      buildDir: realBuildDir,
    };
  }
  const start = dirname(realBuildDir);
  const strong = nearestMarker(start, STRONG_MARKERS);
  const found = strong ?? nearestMarker(start, WEAK_MARKERS);
  const projectRoot = found?.root ?? start;
  const dir = join(projectRoot, AFTERPACK_DIR);
  if (isWithinDir(realBuildDir, dir)) {
    throw new AfterpackFilesError(
      DIAG_AFTERPACK_DIR_IN_OUTPUT,
      `AfterPack would keep its files in ${dir}, inside the build output ${realBuildDir}, where ` +
        "they would ship.",
      "Point AfterPack at a build directory below your project root.",
    );
  }
  return {
    dir,
    projectRoot,
    marker: found?.marker ?? null,
    strong: strong !== null,
    buildDir: realBuildDir,
  };
}

export function describeUnanchoredHome(home: AfterpackHome): string | null {
  if (home.marker !== null) return null;
  return (
    `no lockfile, afterpack.json, .git or package.json above ${home.buildDir}, so AfterPack ` +
    `keeps its files beside it, in ${home.dir}`
  );
}
