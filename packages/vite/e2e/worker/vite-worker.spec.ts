import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { expectObfuscationPass, readBuildLog } from "@e2e/helpers/build-log.js";
import { readExpectations, smokeOf } from "@e2e/helpers/expectations.js";
import { hashedNamesTest } from "@e2e/helpers/hashed-names.js";
import { baseURLOf, fixture } from "@e2e/helpers/registry.js";
import { expectObfuscationSignatures, protectedFilesOf } from "@e2e/helpers/signatures.js";
import { runSmoke } from "@e2e/helpers/smoke.js";

const app = fixture("vite-worker");
const expectations = readExpectations(app);
const dist = join(app.dir, "dist");

function builtAssets(): string[] {
  return readdirSync(join(dist, "assets"))
    .filter((name) => !name.endsWith(".map"))
    .map((name) => `/assets/${name}`)
    .sort();
}

test.describe("Vite 8 ships a module Web Worker and a precaching service worker", {
  tag: "@quick",
}, () => {
  test("the build ran a real obfuscation pass over the shipped files", { tag: "@node" }, () => {
    expectObfuscationPass(readBuildLog(app), app.name, expectations.obfuscation);
  });

  test("the worker Vite built in its own sub-build is among the obfuscated files", {
    tag: "@node",
  }, () => {
    const protectedNames = protectedFilesOf(app).map((file) => file.path);
    expect(protectedNames.some((name) => /^assets\/solver\.worker-[\w-]{8}\.js$/.test(name))).toBe(
      true,
    );
    expectObfuscationSignatures(app);
  });

  test("the precache manifest names exactly the hashed files the build wrote", {
    tag: "@node",
  }, () => {
    const manifest = JSON.parse(readFileSync(join(dist, "precache-manifest.json"), "utf8"));
    expect(manifest).toEqual(builtAssets());
    expect(readFileSync(join(dist, "sw.js"), "utf8")).toContain(JSON.stringify(manifest));
  });

  test("the obfuscated worker still answers", async ({ page }) => {
    await runSmoke(page, baseURLOf(app), smokeOf(expectations));
  });

  test("a page the service worker controls loads the worker from the precache", async ({
    page,
  }) => {
    await page.goto(baseURLOf(app));
    await expect(page.getByTestId("offline")).toHaveText("service worker ready");
    await page.reload();
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
      .toBe(true);
    const cached = await page.evaluate(async () => {
      const cache = await caches.open("precache");
      return (await cache.keys()).map((request) => new URL(request.url).pathname).sort();
    });
    expect(cached).toEqual(builtAssets());
    await page.getByTestId("solve").click();
    await expect(page.getByTestId("answer")).toHaveText("1716 paths through a 6x7 grid");
  });
});

hashedNamesTest();
