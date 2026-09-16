import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface Framework {
  dep: string;
  name: string;
  afterpackPackage: string;
  docsPath: string;
  outputDir: string;
}

export const FRAMEWORKS: readonly Framework[] = [
  {
    dep: "@sveltejs/kit",
    name: "SvelteKit",
    afterpackPackage: "@afterpack/sveltekit",
    docsPath: "sveltekit",
    outputDir: "build",
  },
  {
    dep: "astro",
    name: "Astro",
    afterpackPackage: "@afterpack/astro",
    docsPath: "astro",
    outputDir: "dist",
  },
  {
    dep: "nuxt",
    name: "Nuxt",
    afterpackPackage: "@afterpack/nuxt",
    docsPath: "nuxt",
    outputDir: ".output",
  },
  {
    dep: "next",
    name: "Next.js",
    afterpackPackage: "@afterpack/next",
    docsPath: "nextjs",
    outputDir: ".next",
  },
  {
    dep: "@angular/core",
    name: "Angular",
    afterpackPackage: "@afterpack/angular",
    docsPath: "angular",
    outputDir: "dist",
  },
  {
    dep: "electron",
    name: "Electron",
    afterpackPackage: "@afterpack/electron",
    docsPath: "electron",
    outputDir: "out",
  },
  {
    dep: "svelte",
    name: "Svelte",
    afterpackPackage: "@afterpack/svelte",
    docsPath: "svelte",
    outputDir: "dist",
  },
  {
    dep: "vue",
    name: "Vue",
    afterpackPackage: "@afterpack/vue",
    docsPath: "vue",
    outputDir: "dist",
  },
  {
    dep: "parcel",
    name: "Parcel",
    afterpackPackage: "@afterpack/parcel-optimizer",
    docsPath: "parcel",
    outputDir: "dist",
  },
  {
    dep: "vite",
    name: "Vite",
    afterpackPackage: "@afterpack/vite",
    docsPath: "vite",
    outputDir: "dist",
  },
  {
    dep: "webpack",
    name: "webpack",
    afterpackPackage: "@afterpack/webpack",
    docsPath: "webpack",
    outputDir: "dist",
  },
  {
    dep: "rollup",
    name: "Rollup",
    afterpackPackage: "@afterpack/rollup",
    docsPath: "rollup",
    outputDir: "dist",
  },
  {
    dep: "esbuild",
    name: "esbuild",
    afterpackPackage: "@afterpack/esbuild",
    docsPath: "esbuild",
    outputDir: "dist",
  },
];

export const OUTPUT_DIRS = ["dist", "build", "out", ".output", ".next"] as const;

export function frameworkDocsUrl(framework: Framework): string {
  return `https://www.afterpack.dev/docs/frameworks/${framework.docsPath}`;
}

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

export function detectFramework(cwd: string): Framework | null {
  const deps = readDependencies(cwd);
  return FRAMEWORKS.find((f) => f.dep in deps) ?? null;
}

export function detectIntegration(cwd: string, framework: Framework): boolean {
  return framework.afterpackPackage in readDependencies(cwd);
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

export function detectBuildOutput(
  cwd: string,
  framework?: Framework | null,
): DetectedOutput | null {
  const present: { dir: string; mtime: number }[] = [];
  for (const dir of OUTPUT_DIRS) {
    const mtime = directoryMtime(cwd, dir);
    if (mtime !== null) present.push({ dir, mtime });
  }
  if (present.length === 0) return null;

  const resolved = framework === undefined ? detectFramework(cwd) : framework;
  if (resolved && present.some((c) => c.dir === resolved.outputDir)) {
    return { dir: resolved.outputDir, reason: `${resolved.name} writes it` };
  }
  const newest = present.reduce((best, c) => (c.mtime > best.mtime ? c : best));
  return { dir: newest.dir, reason: "the newest build output here" };
}
