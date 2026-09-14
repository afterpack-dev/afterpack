import { join } from "node:path";
import { defineConfig } from "@playwright/test";
import { assertFixturesInstalled } from "./e2e/global-setup.js";
import { FIXTURES, REPO_ROOT } from "./e2e/helpers/registry.js";

const BUILD_AND_SERVE = join(REPO_ROOT, "e2e", "helpers", "build-and-serve.mjs");
const SERVER_TIMEOUT_MS = 10 * 60 * 1000;

assertFixturesInstalled();

export default defineConfig({
  testDir: "./packages",
  testMatch: "**/e2e/**/*.spec.ts",
  tsconfig: "./tsconfig.json",
  outputDir: ".afterpack/e2e/test-results",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  timeout: 10 * 60 * 1000,
  expect: { timeout: 20_000 },
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: ".afterpack/e2e/playwright-report" }],
  ],
  use: { trace: "retain-on-failure" },
  projects: FIXTURES.map((fixture) => ({
    name: fixture.name,
    testMatch: `**/${fixture.relativeDir}/*.spec.ts`,
    use: { baseURL: fixture.baseURL ?? undefined },
  })),
  webServer: FIXTURES.filter((fixture) => fixture.serveCommand !== null).map((fixture) => ({
    command: `node "${BUILD_AND_SERVE}" "${fixture.buildLog}" "${fixture.buildCommand}" "${fixture.serveCommand}"`,
    cwd: fixture.dir,
    url: fixture.baseURL as string,
    env: fixture.env,
    reuseExistingServer: false,
    timeout: SERVER_TIMEOUT_MS,
    stdout: "pipe",
    stderr: "pipe",
  })),
});
