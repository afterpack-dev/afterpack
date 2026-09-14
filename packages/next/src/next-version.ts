import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { LABEL } from "./hook.js";

export const MIN_NEXT_VERSION = "15.4.0";

type Triple = [number, number, number];

function parseVersion(version: string): Triple | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function isBelow(found: Triple, floor: Triple): boolean {
  for (let i = 0; i < 3; i++) {
    if (found[i] !== floor[i]) return found[i] < floor[i];
  }
  return false;
}

function installedNextManifest(fromDir: string): string | null {
  let current = resolve(fromDir);
  for (;;) {
    const candidate = join(current, "node_modules", "next", "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function detectNextVersion(fromDir: string = process.cwd()): string | null {
  const manifest = installedNextManifest(fromDir);
  if (manifest === null) return null;
  try {
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

export function assertSupportedNext(version: string | null): void {
  if (version === null) return;
  const found = parseVersion(version);
  const floor = parseVersion(MIN_NEXT_VERSION) as Triple;
  if (!found || !isBelow(found, floor)) return;
  throw new Error(
    `[${LABEL}] Next.js ${version} is too old for @afterpack/next, which needs ` +
      `next >= ${MIN_NEXT_VERSION}. withAfterpackNext() installs Next's ` +
      `\`compiler.runAfterProductionCompile\` hook, added in ${MIN_NEXT_VERSION}: on ${version} ` +
      "`next build` silently IGNORES it, exits 0, and ships your bundle AS CLEARTEXT. " +
      `Upgrade to next@>=${MIN_NEXT_VERSION}, or drop withAfterpackNext() and obfuscate the ` +
      "build output with `npx afterpack@latest .next` as a separate step.",
  );
}
