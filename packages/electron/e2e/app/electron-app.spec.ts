import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  expectObfuscationPass,
  expectOneSeedAcrossLegs,
  readBuildLog,
} from "@e2e/helpers/build-log.js";
import { expectObfuscatedAndDeterministic, runBuild } from "@e2e/helpers/build.js";
import { readExpectations } from "@e2e/helpers/expectations.js";
import { baseURLOf, fixture } from "@e2e/helpers/registry.js";
import { collectConsoleErrors, expectNoConsoleErrors } from "@e2e/helpers/smoke.js";

const app = fixture("electron-app");
const expectations = readExpectations(app);
const spec = expectations.electron;
if (!spec) throw new Error("the electron fixture needs an `electron` block in expectations.json");
const LEGS = app.targets.length;

test.describe("electron-vite emits main, preload and renderer", { tag: "@quick" }, () => {
  test("the build ran a real obfuscation pass over all three legs", () => {
    expectObfuscationPass(readBuildLog(app), app.name, expectations.obfuscation);
  });

  test("node runs the obfuscated main and preload bundles across the IPC boundary", () => {
    const result = spawnSync(process.execPath, [join(app.dir, "harness", "run-node-legs.mjs")], {
      cwd: app.dir,
      encoding: "utf8",
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  test("chromium runs the obfuscated renderer bundle over the stubbed bridge", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await page.addInitScript({
      content:
        `window.afterpack = { total: async () => (${JSON.stringify(spec.bridge.expectSummary)}), ` +
        `info: async () => (${JSON.stringify(spec.bridge.expectInfo)}), ` +
        `label: () => ${JSON.stringify(spec.bridge.expectLabel.output)} };`,
    });
    await page.goto(baseURLOf(app), { waitUntil: "networkidle" });

    await expect(page.locator('[data-testid="title"]')).toHaveText(spec.renderer.title);
    await page.locator('[data-testid="counter"]').click();
    await expect(page.locator('[data-testid="counter"]')).toHaveText(
      spec.renderer.counterAfterClick,
    );
    await expect(page.locator('[data-testid="bridge"]')).toHaveText(spec.renderer.bridgeText);
    expectNoConsoleErrors(errors);
  });
});

test.describe("electron-vite emits main, preload and renderer, byte-level proof", () => {
  test("the output differs from an unobfuscated build and repeats byte for byte", () => {
    expectObfuscatedAndDeterministic(app);
  });

  test("every leg shares one seed, freshly drawn per build and pinnable from the environment", () => {
    const rerunLog = `${app.buildLog}.rerun`;
    const first = expectOneSeedAcrossLegs(
      runBuild(app, { AFTERPACK_FI_FREE_SEED: "1" }, rerunLog),
      `${app.name} free seed`,
      LEGS,
    );
    const second = expectOneSeedAcrossLegs(
      runBuild(app, { AFTERPACK_FI_FREE_SEED: "1" }, rerunLog),
      `${app.name} free seed again`,
      LEGS,
    );
    expect(second, "two consecutive builds drew the same seed").not.toBe(first);

    const pinned = "424242";
    const fromEnv = expectOneSeedAcrossLegs(
      runBuild(app, { AFTERPACK_FI_FREE_SEED: "1", AFTERPACK_SEED: pinned }, rerunLog),
      `${app.name} env seed`,
      LEGS,
    );
    expect(fromEnv).toBe(pinned);
  });
});
