import { test } from "@playwright/test";
import { expectObfuscationPass, readBuildLog } from "@e2e/helpers/build-log.js";
import { expectObfuscatedAndDeterministic } from "@e2e/helpers/build.js";
import { readExpectations, smokeOf } from "@e2e/helpers/expectations.js";
import { baseURLOf, fixture } from "@e2e/helpers/registry.js";
import { runSmoke } from "@e2e/helpers/smoke.js";

const app = fixture("sveltekit-app");
const expectations = readExpectations(app);

test.describe("SvelteKit prerenders with the static adapter", { tag: "@quick" }, () => {
  test("the build ran a real obfuscation pass over the shipped files", () => {
    expectObfuscationPass(readBuildLog(app), app.name, expectations.obfuscation);
  });

  test("the obfuscated output still renders and still reacts to a click", async ({ page }) => {
    await runSmoke(page, baseURLOf(app), smokeOf(expectations));
  });
});

test.describe("SvelteKit prerenders with the static adapter, byte-level proof", () => {
  test("the output differs from an unobfuscated build and repeats byte for byte", () => {
    expectObfuscatedAndDeterministic(app);
  });
});
