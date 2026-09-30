import { existsSync } from "node:fs";
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

export function assertFixturesBuilt(fixtures: Fixture[]): void {
  const missing = fixtures
    .flatMap(buildJobsOf)
    .filter((job) => !existsSync(job.log))
    .map((job) => `  ${job.label}`);
  if (missing.length === 0) return;
  throw new Error(
    `${missing.length} e2e fixture build(s) never ran:\n${missing.join("\n")}\n\n` +
      "Run the suite through `pnpm e2e` or `pnpm e2e:quick`, or build first with:\n  pnpm e2e:build\n",
  );
}
