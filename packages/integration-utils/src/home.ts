import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const AFTERPACK_DIR = ".afterpack";

const PROJECT_MARKERS = ["package.json", "afterpack.json", ".git"] as const;

export interface AfterpackHome {
  dir: string;
  projectRoot: string;
  marker: string | null;
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

function markerIn(dir: string): string | null {
  return PROJECT_MARKERS.find((name) => existsSync(join(dir, name))) ?? null;
}

export function afterpackHome(buildDir: string, options: AfterpackHomeOptions = {}): AfterpackHome {
  const realBuildDir = realPath(buildDir);
  const ownMarker = options.fileTarget ? markerIn(realBuildDir) : null;
  if (ownMarker !== null) {
    return {
      dir: join(realBuildDir, AFTERPACK_DIR),
      projectRoot: realBuildDir,
      marker: ownMarker,
      buildDir: realBuildDir,
    };
  }
  const start = dirname(realBuildDir);
  let found: { root: string; marker: string } | null = null;
  for (let current = start; ; ) {
    const marker = markerIn(current);
    if (marker) {
      found = { root: current, marker };
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const projectRoot = found?.root ?? start;
  const dir = join(projectRoot, AFTERPACK_DIR);
  if (isWithinDir(realBuildDir, dir)) {
    throw new Error(
      `AfterPack would keep its files in ${dir}, inside the build output ${realBuildDir}, where ` +
        "they would ship. Point AfterPack at a build directory below your project root.",
    );
  }
  return { dir, projectRoot, marker: found?.marker ?? null, buildDir: realBuildDir };
}

export function describeUnanchoredHome(home: AfterpackHome): string | null {
  if (home.marker !== null) return null;
  return (
    `no package.json, afterpack.json or .git above ${home.buildDir}, so AfterPack keeps its ` +
    `files beside it, in ${home.dir}`
  );
}
