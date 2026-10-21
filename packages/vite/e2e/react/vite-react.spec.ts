import { expect, test } from "@playwright/test";
import { expectObfuscationPass, readBuildLog } from "@e2e/helpers/build-log.js";
import { readExpectations, smokeOf } from "@e2e/helpers/expectations.js";
import { candidateLaneTests } from "@e2e/helpers/lanes.js";
import { notesJourney, notesReloadJourney } from "@e2e/helpers/notes-app.js";
import { baseURLOf, fixture } from "@e2e/helpers/registry.js";
import {
  parityProblems,
  recordScenario,
  type ScenarioSteps,
  scenario,
} from "@e2e/helpers/scenario.js";
import {
  expectLiteralsHidden,
  expectObfuscationSignatures,
  signatureFailures,
  unprotectedBaselineSignature,
} from "@e2e/helpers/signatures.js";
import { collectConsoleErrors, expectNoConsoleErrors, runSmoke } from "@e2e/helpers/smoke.js";
import { expectSourceMap } from "@e2e/helpers/source-map.js";
import { hashedNamesTest } from "@e2e/helpers/hashed-names.js";

const app = fixture("vite-react");
const expectations = readExpectations(app);

const firstVisit: ScenarioSteps = async ({ page, goto, checkpoint }) => {
  await goto("/");
  await expect(page.getByTestId("title")).toHaveText("Vite + React fixture");
  await checkpoint("first visit");
};

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

test.describe("Vite 8 builds a React 19 SPA, as a user drives it", { tag: "@quick" }, () => {
  test(
    "navigating, validating the form and opening the lazy report match the baseline",
    { tag: "@scenario" },
    scenario(notesJourney("Vite + React fixture")),
  );

  test(
    "notes saved to localStorage survive a reload, as in the baseline",
    { tag: "@scenario" },
    scenario(notesReloadJourney),
  );

  test("the parity check fails a protected build that logs, fetches or renders something new", async ({
    browser,
  }) => {
    const baseline = await recordScenario(browser, app, "baseline", firstVisit);
    const tampered = await recordScenario(browser, app, "protected", firstVisit, {
      url: /\/assets\/index-[^/]+\.js$/,
      transform: (body) =>
        `console.error("tampered");fetch("/tampered");document.body.append("tampered");${body}`,
    });
    const problems = parityProblems(baseline, tampered);
    expect(problems).toEqual(
      expect.arrayContaining([
        "new console.error: tampered",
        "request only the protected build made: GET /tampered 200",
        expect.stringContaining('checkpoint "first visit" differs'),
      ]),
    );
    expect(
      parityProblems(baseline, await recordScenario(browser, app, "protected", firstVisit)),
    ).toEqual([]);
  });
});

candidateLaneTests();

test.describe("Vite 8 builds a React 19 SPA, full suite", () => {
  test("the same bundle drives the counter inside a separate iframe realm", async ({ page }) => {
    const base = baseURLOf(app);
    const errors = collectConsoleErrors(page);
    await page.goto(base);
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

hashedNamesTest();
