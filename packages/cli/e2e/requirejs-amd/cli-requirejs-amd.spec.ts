import { expect, test } from "@playwright/test";
import { expectObfuscationPass, readBuildLog } from "@e2e/helpers/build-log.js";
import { readExpectations, smokeOf } from "@e2e/helpers/expectations.js";
import { baseURLOf, fixture } from "@e2e/helpers/registry.js";
import { expectObfuscationSignatures } from "@e2e/helpers/signatures.js";
import { runSmoke } from "@e2e/helpers/smoke.js";

const app = fixture("cli-requirejs-amd");
const expectations = readExpectations(app);

test.describe(
  "the CLI obfuscates AMD modules require.js loads at runtime",
  { tag: "@quick" },
  () => {
    test("the build ran a real obfuscation pass over the shipped files", { tag: "@node" }, () => {
      expectObfuscationPass(readBuildLog(app), app.name, expectations.obfuscation);
    });

    test(
      "the shipped files carry obfuscation signatures, not mere minification",
      { tag: "@node" },
      () => {
        expectObfuscationSignatures(app);
      },
    );

    test("the obfuscated output still renders and still reacts to a click", async ({ page }) => {
      await runSmoke(page, baseURLOf(app), smokeOf(expectations));
    });
  },
);

test.describe("the CLI obfuscates AMD modules require.js loads at runtime, full suite", () => {
  test("the click waits for require.js to wire the module, however late it does", async ({
    page,
  }) => {
    await page.route("**/modules/calc.js", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await route.continue();
    });
    await runSmoke(page, baseURLOf(app), smokeOf(expectations));
  });

  test("the smoke check refuses a ready marker the served HTML already carries", async ({
    page,
  }) => {
    const base = baseURLOf(app);
    await page.route(`${base}/`, async (route) => {
      const response = await route.fetch();
      const html = await response.text();
      expect(html, "the tag this test tampers with").toContain("<body>");
      await route.fulfill({ response, body: html.replace("<body>", "<body data-app-ready>") });
    });
    await expect(runSmoke(page, base, smokeOf(expectations))).rejects.toThrow(
      /the served HTML already matches body\[data-app-ready\]/,
    );
  });
});
