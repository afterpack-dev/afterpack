import { join } from "node:path";
import { test } from "@playwright/test";
import { expectObfuscationPass, readBuildLog } from "@e2e/helpers/build-log.js";
import { readExpectations, smokeOf } from "@e2e/helpers/expectations.js";
import { expectProtectionReceipt } from "@e2e/helpers/receipt.js";
import { baseURLOf, fixture } from "@e2e/helpers/registry.js";
import { expectObfuscationSignatures } from "@e2e/helpers/signatures.js";
import { runSmoke } from "@e2e/helpers/smoke.js";

const app = fixture("nuxt-app");
const expectations = readExpectations(app);

test.describe("Nuxt 3 prerenders a static site", { tag: "@quick" }, () => {
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

  test(
    "the served client chunks are the obfuscated ones the receipt names",
    { tag: "@node" },
    () => {
      expectProtectionReceipt(app, join(app.dir, ".nuxt/dist/client"), join(app.dir, ".output/public"));
    },
  );

  test("the obfuscated output still renders and still reacts to a click", async ({ page }) => {
    await runSmoke(page, baseURLOf(app), smokeOf(expectations));
  });
});
