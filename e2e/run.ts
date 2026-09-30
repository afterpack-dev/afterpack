import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { buildFixtures } from "./build-fixtures.js";
import { BROWSERS, selectedFixtures } from "./helpers/registry.js";

const args = process.argv.slice(2);
const quick = args[0] === "--quick";
const passthrough = quick ? args.slice(1) : args;

if (!process.env.AFTERPACK_E2E_BROWSERS) {
  process.env.AFTERPACK_E2E_BROWSERS = quick ? "chromium" : BROWSERS.join(",");
}

const fixtures = selectedFixtures();
console.log(
  `${quick ? "quick" : "full"} lane: ${fixtures.length} fixture(s) on ${process.env.AFTERPACK_E2E_BROWSERS}`,
);

if (!(await buildFixtures(fixtures))) process.exit(1);

const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
const result = spawnSync(
  process.execPath,
  [cli, "test", ...(quick ? ["--grep", "@quick"] : []), ...passthrough],
  { stdio: "inherit", env: process.env },
);
process.exit(result.status ?? 1);
