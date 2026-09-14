import { type Dirent, existsSync, readdirSync, type Stats, statSync } from "node:fs";
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

function entriesOf(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function kindOf(entry: Dirent, full: string): "dir" | "file" | null {
  if (entry.isDirectory()) return "dir";
  if (entry.isFile()) return "file";
  const stat = statOrNull(full);
  if (!stat) return null;
  return stat.isDirectory() ? "dir" : "file";
}

function walkJs(dir: string, include: readonly string[], readmitted: boolean): string[] {
  const out: string[] = [];
  for (const entry of entriesOf(dir)) {
    const name = entry.name;
    const full = join(dir, name);
    const kind = kindOf(entry, full);
    if (kind === null) continue;
    if (kind === "dir") {
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
  for (const entry of entriesOf(dir)) {
    const name = entry.name;
    const full = join(dir, name);
    const kind = kindOf(entry, full);
    if (kind === null) continue;
    if (kind === "dir") {
      out.push(...collectSourceMaps(full));
    } else if (isSourceMap(name)) {
      out.push(full);
    }
  }
  return out;
}
