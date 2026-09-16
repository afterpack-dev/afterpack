import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface PackageManager {
  name: string;
  install(pkg: string): string;
  run(script: string): string;
}

export const NPM: PackageManager = {
  name: "npm",
  install: (pkg) => `npm install -D ${pkg}`,
  run: (script) => `npm run ${script}`,
};

export const PNPM: PackageManager = {
  name: "pnpm",
  install: (pkg) => `pnpm add -D ${pkg}`,
  run: (script) => `pnpm ${script}`,
};

export const YARN: PackageManager = {
  name: "yarn",
  install: (pkg) => `yarn add -D ${pkg}`,
  run: (script) => `yarn ${script}`,
};

export const BUN: PackageManager = {
  name: "bun",
  install: (pkg) => `bun add -d ${pkg}`,
  run: (script) => `bun run ${script}`,
};

function lockfileAt(dir: string): PackageManager | null {
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return PNPM;
  if (existsSync(join(dir, "yarn.lock"))) return YARN;
  if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) return BUN;
  if (existsSync(join(dir, "package-lock.json"))) return NPM;
  return null;
}

export function detectPackageManager(cwd: string): PackageManager {
  let current = cwd;
  for (;;) {
    const found = lockfileAt(current);
    if (found) return found;
    const parent = dirname(current);
    if (parent === current) return NPM;
    current = parent;
  }
}
