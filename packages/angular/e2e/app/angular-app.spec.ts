import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
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

const app = fixture("angular-app");
const expectations = readExpectations(app);
const BROWSER_DIR = join(app.dir, "dist", "angular-fixture", "browser");

test.describe("the Angular application builder emits a browser bundle", { tag: "@quick" }, () => {
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

  test("the combined Protection Map lands outside the served directory", { tag: "@node" }, () => {
    expect(existsSync(join(app.dir, ".afterpack", "protectionMap.html"))).toBe(true);
    const leaked = readdirSync(BROWSER_DIR).filter((name) => /protectionMap|\.backup\./.test(name));
    expect(leaked, "the served browser directory must carry no AfterPack artifacts").toEqual([]);
  });

  test("the obfuscated output still renders and still reacts to a click", async ({ page }) => {
    await runSmoke(page, baseURLOf(app), smokeOf(expectations));
  });
});

test.describe("the Angular application builder emits a browser bundle, as a user drives it", () => {
  test(
    "router navigation, @Input/@Output with @HostListener, the Validators form, the NgModule component, the pipe and the loadComponent route match the baseline",
    { tag: "@scenario" },
    scenario(notesJourney("Angular fixture")),
  );

  test(
    "notes saved to localStorage survive a reload, as in the baseline",
    { tag: "@scenario" },
    scenario(notesReloadJourney),
  );
});

candidateLaneTests();

hashedNamesTest();
