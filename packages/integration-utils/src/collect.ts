import { existsSync, readdirSync, type Stats, statSync } from "node:fs";
import { basename, join } from "node:path";
import { matchesPath, reachesInto } from "./glob.js";

const BACKUP_RE = /\.backup\.[0-9a-f]{8}\.[cm]?js$/;

const NODE_MODULES = "node_modules";

function isCollectableJs(name: string): boolean {
  if (BACKUP_RE.test(name)) return false;
  return name.endsWith(".js") || name.endsWith(".mjs") || name.endsWith(".cjs");
}

function statOrNull(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

export interface CollectJsOptions {
  include?: readonly string[];
}

export function collectJsFiles(target: string, options: CollectJsOptions = {}): string[] {
  const stat = statOrNull(target);
  if (!stat) return [];
  if (!stat.isDirectory()) return isCollectableJs(basename(target)) ? [target] : [];
  return walkJs(target, options.include ?? [], false);
}

function walkJs(dir: string, include: readonly string[], readmitted: boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statOrNull(full);
    if (!stat) continue;
    if (stat.isDirectory()) {
      const skipped = name === NODE_MODULES;
      if (skipped && !include.some((pattern) => reachesInto(pattern, full))) continue;
      out.push(...walkJs(full, include, readmitted || skipped));
    } else if (isCollectableJs(name)) {
      if (readmitted && !include.some((pattern) => matchesPath(pattern, full))) continue;
      out.push(full);
    }
  }
  return out;
}

function isSourceMap(name: string): boolean {
  return name.endsWith(".js.map") || name.endsWith(".mjs.map") || name.endsWith(".cjs.map");
}

export function collectSourceMaps(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statOrNull(full);
    if (!stat) continue;
    if (stat.isDirectory()) {
      out.push(...collectSourceMaps(full));
    } else if (isSourceMap(name)) {
      out.push(full);
    }
  }
  return out;
}
