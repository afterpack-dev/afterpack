import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { SourceType } from "@afterpack/integration-utils";

export interface AngularScriptKinds {
  module: string[];
  classic: string[];
  unclaimed: string[];
}

const SCRIPT_TAG_RE = /<script\b([^>]*)>/gi;
const MODULEPRELOAD_RE = /<link\b([^>]*)>/gi;
const STATIC_SPECIFIER_RE = /(?:\bfrom|\bimport)\s*["']([^"']+)["']/g;
const DYNAMIC_SPECIFIER_RE = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
const MODULE_WORKER_RE =
  /\bnew\s+(?:Shared)?Worker\(\s*new\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)\s*,\s*\{\s*type\s*:\s*["']module["']/g;

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(
    tag,
  );
  if (!match) return null;
  return match[2] ?? match[3] ?? match[4] ?? "";
}

function htmlFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".html"))
    .map((name) => join(dir, name));
}

function localTarget(base: string, ref: string, browserDir: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//")) return null;
  const path = ref.split(/[?#]/)[0];
  if (path === "") return null;
  const target = path.startsWith("/") ? join(browserDir, path) : resolve(base, path);
  const rel = relative(browserDir, target);
  if (rel.startsWith("..") || rel.startsWith(sep)) return null;
  return target;
}

export function classifyAngularScripts(
  browserDir: string,
  files: readonly string[],
): AngularScriptKinds {
  const collected = new Set(files.map((file) => resolve(file)));
  const module = new Set<string>();
  const classic = new Set<string>();
  const pending: string[] = [];
  const claimModule = (target: string | null): void => {
    if (target === null || !collected.has(target) || module.has(target)) return;
    module.add(target);
    pending.push(target);
  };

  for (const html of htmlFiles(browserDir)) {
    const text = readFileSync(html, "utf8");
    const base = dirname(html);
    for (const [, tag] of text.matchAll(SCRIPT_TAG_RE)) {
      const src = attribute(tag, "src");
      if (src === null) continue;
      const target = localTarget(base, src, browserDir);
      if ((attribute(tag, "type") ?? "").trim().toLowerCase() === "module") claimModule(target);
      else if (target !== null && collected.has(target)) classic.add(target);
    }
    for (const [, tag] of text.matchAll(MODULEPRELOAD_RE)) {
      if ((attribute(tag, "rel") ?? "").trim().toLowerCase() !== "modulepreload") continue;
      const href = attribute(tag, "href");
      if (href !== null) claimModule(localTarget(base, href, browserDir));
    }
  }

  while (pending.length > 0) {
    const file = pending.pop() as string;
    const code = readFileSync(file, "utf8");
    const base = dirname(file);
    for (const re of [STATIC_SPECIFIER_RE, DYNAMIC_SPECIFIER_RE, MODULE_WORKER_RE]) {
      for (const [, ref] of code.matchAll(re)) {
        const relativeRef = re === MODULE_WORKER_RE && !/^[./]/.test(ref) ? `./${ref}` : ref;
        if (!/^\.{1,2}\//.test(relativeRef) && !relativeRef.startsWith("/")) continue;
        claimModule(localTarget(base, relativeRef, browserDir));
      }
    }
  }

  const sorted = (paths: Iterable<string>) => [...paths].sort();
  return {
    module: sorted([...module].filter((file) => !classic.has(file))),
    classic: sorted(classic),
    unclaimed: sorted([...collected].filter((file) => !module.has(file) && !classic.has(file))),
  };
}

export function angularSourceType(kinds: AngularScriptKinds): SourceType | undefined {
  if (kinds.module.length === 0) return undefined;
  return kinds.classic.length === 0 && kinds.unclaimed.length === 0 ? "module" : undefined;
}
