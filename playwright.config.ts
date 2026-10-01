import { defineConfig } from "@playwright/test";
import {
  type BrowserName,
  type Fixture,
  playwrightWorkers,
  selectedBrowsers,
  selectedFixtures,
} from "./e2e/helpers/registry.js";
import { assertFixturesBuilt, assertFixturesInstalled } from "./e2e/preflight.js";

const SERVER_TIMEOUT_MS = 2 * 60 * 1000;
const fixtures = selectedFixtures();
const browsers = selectedBrowsers();
const primary: BrowserName = browsers.includes("chromium") ? "chromium" : browsers[0];

assertFixturesInstalled(fixtures);
assertFixturesBuilt(fixtures);

function projectName(fixture: Fixture, browserName: BrowserName): string {
  return browserName === "chromium" ? fixture.name : `${fixture.name}@${browserName}`;
}

function server(command: string, cwd: string, url: string, env: Record<string, string>) {
  return {
    command,
    cwd,
    url,
    env,
    reuseExistingServer: false,
    timeout: SERVER_TIMEOUT_MS,
    stdout: "pipe" as const,
    stderr: "pipe" as const,
  };
}

export default defineConfig({
  testDir: "./packages",
  testMatch: "**/e2e/**/*.spec.ts",
  tsconfig: "./tsconfig.json",
  outputDir: ".afterpack/e2e/test-results",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: playwrightWorkers(),
  timeout: 5 * 60 * 1000,
  expect: { timeout: 20_000 },
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: ".afterpack/e2e/playwright-report" }],
  ],
  use: { trace: "retain-on-failure" },
  projects: fixtures.flatMap((fixture) =>
    browsers.map((browserName) => ({
      name: projectName(fixture, browserName),
      testMatch: `**/${fixture.relativeDir}/*.spec.ts`,
      grepInvert: browserName === primary ? undefined : /@node/,
      dependencies: browserName === primary ? [] : [projectName(fixture, primary)],
      metadata: { fixture: fixture.name },
      use: { browserName, baseURL: fixture.baseURL ?? undefined },
    })),
  ),
  webServer: fixtures.flatMap((fixture) => [
    ...(fixture.serveCommand && fixture.baseURL
      ? [server(fixture.serveCommand, fixture.dir, fixture.baseURL, fixture.env)]
      : []),
    ...(fixture.baseline
      ? [
          server(
            fixture.baseline.serveCommand,
            fixture.dir,
            fixture.baseline.baseURL,
            fixture.baseline.env,
          ),
        ]
      : []),
  ]),
});
