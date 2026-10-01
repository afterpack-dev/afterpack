import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { buildJobsOf } from "./build-fixtures.js";
import { type Fixture, fixtureDirs, REPO_ROOT } from "./helpers/registry.js";

export function assertFixturesInstalled(fixtures: Fixture[]): void {
  const missing = fixtureDirs(fixtures).filter((dir) => !existsSync(join(dir, "node_modules")));
  if (missing.length === 0) return;
  const list = missing.map((dir) => `  ${relative(REPO_ROOT, dir)}`).join("\n");
  throw new Error(
    `${missing.length} e2e fixture(s) have no node_modules:\n${list}\n\nRun:\n  pnpm e2e:install\n`,
  );
}

function exitCodeOf(file: string): string | null {
  return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
}

export function assertFixturesBuilt(fixtures: Fixture[]): void {
  const unusable = fixtures.flatMap(buildJobsOf).flatMap((job) => {
    const code = exitCodeOf(job.exitCodeFile);
    if (code === "0") return [];
    return [`  ${job.label}: ${code === null ? "never built" : `failed (exit ${code})`}`];
  });
  if (unusable.length === 0) return;
  throw new Error(
    `${unusable.length} e2e fixture build(s) did not succeed:\n${unusable.join("\n")}\n\n` +
      "Run the suite through `pnpm e2e` or `pnpm e2e:quick`, or build first with:\n  pnpm e2e:build\n",
  );
}
