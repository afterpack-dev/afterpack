import { expect, test } from "@playwright/test";
import { expectObfuscationPass, readBuildLog } from "@e2e/helpers/build-log.js";
import { readExpectations, smokeOf } from "@e2e/helpers/expectations.js";
import { baseURLOf, fixture } from "@e2e/helpers/registry.js";
import {
  expectLiteralsHidden,
  expectObfuscationSignatures,
  signatureFailures,
  unprotectedBaselineSignature,
} from "@e2e/helpers/signatures.js";
import { collectConsoleErrors, expectNoConsoleErrors, runSmoke } from "@e2e/helpers/smoke.js";
import { expectSourceMap } from "@e2e/helpers/source-map.js";

const app = fixture("vite-react");
const expectations = readExpectations(app);

test.describe("Vite 8 builds a React 19 SPA", { tag: "@quick" }, () => {
  test("the build ran a real obfuscation pass over the shipped files", { tag: "@node" }, () => {
    expectObfuscationPass(readBuildLog(app), app.name, expectations.obfuscation);
  });

  test(
    "the shipped files carry obfuscation signatures and hide the baseline's literals",
    { tag: "@node" },
    () => {
      expectLiteralsHidden(app, expectObfuscationSignatures(app));
    },
  );

  test("the same signature check rejects the unprotected baseline build", { tag: "@node" }, () => {
    expect(signatureFailures(unprotectedBaselineSignature(app), app.dir)).not.toEqual([]);
  });

  test("the obfuscated output still renders and still reacts to a click", async ({ page }) => {
    await runSmoke(page, baseURLOf(app), smokeOf(expectations));
  });

  test(
    "every source map shipped beside the obfuscated output is a usable v3 map",
    { tag: "@node" },
    () => {
      expectSourceMap(app);
    },
  );
});

test.describe("Vite 8 builds a React 19 SPA, full suite", () => {
  test("the same bundle drives the counter inside a separate iframe realm", async ({ page }) => {
    const base = baseURLOf(app);
    const errors = collectConsoleErrors(page);
    await page.goto(base, { waitUntil: "networkidle" });
    await page.evaluate((src) => {
      const iframe = document.createElement("iframe");
      iframe.id = "realm-probe";
      iframe.src = src;
      document.body.appendChild(iframe);
    }, base);

    const frame = page.frameLocator("#realm-probe");
    await expect(frame.locator('[data-testid="title"]')).toHaveText("Vite + React fixture");
    await expect(frame.locator('[data-testid="intro"]')).toHaveText(
      "AfterPack framework-integration smoke fixture.",
    );

    await frame.locator('[data-testid="counter"]').click();
    await expect(frame.locator('[data-testid="counter"]')).toHaveText("count is 1 (odd)");

    await page.locator('[data-testid="counter"]').click();
    await expect(page.locator('[data-testid="counter"]')).toHaveText("count is 1 (odd)");

    expectNoConsoleErrors(errors);
  });
});
