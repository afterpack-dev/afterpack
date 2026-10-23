import { expect, test } from "@playwright/test";
import { expectObfuscationPass, readBuildLog } from "@e2e/helpers/build-log.js";
import { readExpectations, smokeOf } from "@e2e/helpers/expectations.js";
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
import { candidateLaneTests } from "@e2e/helpers/lanes.js";

const app = fixture("vite-react-router");
const expectations = readExpectations(app);

test.describe("React Router 7 framework mode renders on the server", { tag: "@quick" }, () => {
  test("the build ran a real obfuscation pass over the client and the server", { tag: "@node" }, () => {
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

  test("every route renders and hydrates, and the counter reacts to a click", async ({ page }) => {
    await runSmoke(page, baseURLOf(app), smokeOf(expectations));
  });
});

test.describe("React Router 7 framework mode renders on the server, as a user drives it", () => {
  test(
    "client navigation, the validated action, context state and route modules match the baseline",
    { tag: "@scenario" },
    scenario(notesJourney("React Router framework fixture")),
  );

  test(
    "notes kept in the session cookie survive a reload, as in the baseline",
    { tag: "@scenario" },
    scenario(notesReloadJourney),
  );
});

candidateLaneTests();

hashedNamesTest();
