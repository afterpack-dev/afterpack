import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fixtureDirs, REPO_ROOT } from "./helpers/registry.js";

export function assertFixturesInstalled(): void {
  const missing = fixtureDirs().filter((dir) => !existsSync(join(dir, "node_modules")));
  if (missing.length === 0) return;
  const list = missing.map((dir) => `  ${relative(REPO_ROOT, dir)}`).join("\n");
  throw new Error(
    `${missing.length} e2e fixture(s) have no node_modules:\n${list}\n\nRun:\n  pnpm e2e:install\n`,
  );
}

export default function globalSetup(): void {
  assertFixturesInstalled();
}
