import { expect, test } from "@playwright/test";
import { expectObfuscationPass, readBuildLog } from "@e2e/helpers/build-log.js";
import { readExpectations, smokeOf } from "@e2e/helpers/expectations.js";
import { candidateLaneTests } from "@e2e/helpers/lanes.js";
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

const app = fixture("astro-islands");
const expectations = readExpectations(app);

test.describe("Astro builds a static site with React islands", { tag: "@quick" }, () => {
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
});

test.describe("Astro builds a static site with React islands, as a user drives it", () => {
  test(
    "ClientRouter navigation, the form island, the shared store and the client:visible island match the baseline",
    { tag: "@scenario" },
    scenario(notesJourney("Astro islands fixture")),
  );

  test(
    "notes saved to localStorage survive a reload, as in the baseline",
    { tag: "@scenario" },
    scenario(notesReloadJourney),
  );
});

candidateLaneTests();

hashedNamesTest();
