import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface Bundler {
  dep: string;
  name: string;
  outputDir: string;
  hint: string;
}

export const BUNDLERS: readonly Bundler[] = [
  {
    dep: "next",
    name: "Next.js",
    outputDir: ".next",
    hint: "detected Next.js — `@afterpack/next` obfuscates your build automatically as a postbuild step.",
  },
  {
    dep: "nuxt",
    name: "Nuxt",
    outputDir: ".output",
    hint: "detected Nuxt — `@afterpack/nuxt` obfuscates the server + client output as part of your build.",
  },
  {
    dep: "vite",
    name: "Vite",
    outputDir: "dist",
    hint: "detected Vite — `@afterpack/vite` hooks your build for region directives + sourcemap chaining.",
  },
  {
    dep: "webpack",
    name: "webpack",
    outputDir: "dist",
    hint: "detected webpack — `@afterpack/webpack` hooks your build for region directives + sourcemap chaining.",
  },
  {
    dep: "rollup",
    name: "Rollup",
    outputDir: "dist",
    hint: "detected Rollup — `@afterpack/rollup` hooks your build for region directives + sourcemap chaining.",
  },
  {
    dep: "esbuild",
    name: "esbuild",
    outputDir: "dist",
    hint: "detected esbuild — `@afterpack/esbuild` hooks your build for region directives + sourcemap chaining.",
  },
];

export const OUTPUT_DIRS = ["dist", "build", "out", ".output", ".next"] as const;

function readDependencies(cwd: string): Record<string, unknown> {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    return { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    return {};
  }
}

export function detectBundler(cwd: string): Bundler | null {
  const deps = readDependencies(cwd);
  return BUNDLERS.find((b) => b.dep in deps) ?? null;
}

function directoryMtime(cwd: string, name: string): number | null {
  try {
    const stats = statSync(join(cwd, name));
    return stats.isDirectory() ? stats.mtimeMs : null;
  } catch {
    return null;
  }
}

export interface DetectedOutput {
  dir: string;
  reason: string;
}

export function detectBuildOutput(cwd: string): DetectedOutput | null {
  const present: { dir: string; mtime: number }[] = [];
  for (const dir of OUTPUT_DIRS) {
    const mtime = directoryMtime(cwd, dir);
    if (mtime !== null) present.push({ dir, mtime });
  }
  if (present.length === 0) return null;

  const bundler = detectBundler(cwd);
  if (bundler && present.some((c) => c.dir === bundler.outputDir)) {
    return { dir: bundler.outputDir, reason: `${bundler.name} writes it` };
  }
  const newest = present.reduce((best, c) => (c.mtime > best.mtime ? c : best));
  return { dir: newest.dir, reason: "the newest build output here" };
}
