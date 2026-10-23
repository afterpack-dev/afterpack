import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { expectObfuscationPass, readBuildLog } from "@e2e/helpers/build-log.js";
import { readExpectations, smokeOf } from "@e2e/helpers/expectations.js";
import { candidateLaneTests } from "@e2e/helpers/lanes.js";
import { expectProtectionReceipt, expectVerifyPasses } from "@e2e/helpers/receipt.js";
import { notesJourney, notesReloadJourney } from "@e2e/helpers/notes-app.js";
import { baseURLOf, fixture } from "@e2e/helpers/registry.js";
import { scenario } from "@e2e/helpers/scenario.js";
import {
  expectLiteralsHidden,
  expectObfuscationSignatures,
  signatureFailures,
  unprotectedBaselineSignature,
} from "@e2e/helpers/signatures.js";
import { runSmoke } from "@e2e/helpers/smoke.js";
import { hashedNamesTest } from "@e2e/helpers/hashed-names.js";

const app = fixture("nuxt-app");
const expectations = readExpectations(app);

test.describe("Nuxt 3 prerenders a static site", { tag: "@quick" }, () => {
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

  test(
    "the served client chunks are the obfuscated ones the receipt names",
    { tag: "@node" },
    () => {
      expectProtectionReceipt(app, join(app.dir, ".nuxt/dist/client"), join(app.dir, ".output/public"));
    },
  );

  test("`afterpack verify .output/public` passes the deployed copy", { tag: "@node" }, () => {
    expectVerifyPasses(app, ".output/public");
  });

  test("the obfuscated output still renders and still reacts to a click", async ({ page }) => {
    await runSmoke(page, baseURLOf(app), smokeOf(expectations));
  });
});

test.describe("Nuxt 3 prerenders a static site, as a user drives it", () => {
  test(
    "NuxtLink navigation, the validated form, useState and the lazy component match the baseline",
    { tag: "@scenario" },
    scenario(notesJourney("Nuxt 3 fixture")),
  );

  test(
    "notes saved to localStorage survive a reload, as in the baseline",
    { tag: "@scenario" },
    scenario(notesReloadJourney),
  );
});

candidateLaneTests();

hashedNamesTest();
