import { expect, test } from "@playwright/test";
import { expectObfuscationPass, readBuildLog } from "@e2e/helpers/build-log.js";
import { readExpectations, smokeOf } from "@e2e/helpers/expectations.js";
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

const app = fixture("vite-react");
const expectations = readExpectations(app);

const TITLE_ERROR = "Give the note a title of at least 3 characters.";
const BODY_ERROR = "Keep the note under 140 characters.";

const firstVisit: ScenarioSteps = async ({ page, checkpoint }) => {
  await page.goto("/");
  await expect(page.getByTestId("title")).toHaveText("Vite + React fixture");
  await checkpoint("first visit");
};

const noteJourney: ScenarioSteps = async ({ page, checkpoint, inPlace }) => {
  await page.goto("/");
  await page.getByTestId("counter").click();
  await page.getByTestId("counter").click();
  await expect(page.getByTestId("counter")).toHaveText("count is 2 (even)");

  await inPlace("the Notes link", async () => {
    await page.getByRole("link", { name: "Notes" }).click();
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible();
  });
  await expect(page).toHaveURL(/\/notes$/);

  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByRole("alert")).toHaveText([TITLE_ERROR]);
  await page.getByLabel("Title").fill("Hi");
  await page.getByLabel("Body").fill("x".repeat(141));
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByRole("alert")).toHaveText([TITLE_ERROR, BODY_ERROR]);
  await checkpoint("both fields rejected");

  await page.getByLabel("Title").fill("Groceries");
  await page.getByLabel("Body").fill("Milk and bread");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved note 1: Groceries");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await checkpoint("note saved");

  await inPlace("the Reports link to a lazily loaded route", async () => {
    await page.getByRole("link", { name: "Reports" }).click();
    await expect(page.getByTestId("report-summary")).toHaveText("1 note, 4 words");
  });
  await expect(page.getByTestId("report-longest")).toHaveText("Longest title: Groceries");
  await checkpoint("report");

  await inPlace("history back", async () => {
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible();
  });
  await expect(page.getByRole("list", { name: "Saved notes" })).toContainText("Groceries");
  await inPlace("history forward", async () => {
    await page.goForward();
    await expect(page.getByTestId("report-summary")).toHaveText("1 note, 4 words");
  });

  await inPlace("the Home link", async () => {
    await page.getByRole("link", { name: "Home" }).click();
    await expect(page.getByTestId("counter")).toHaveText("count is 2 (even)");
  });
  await checkpoint("home keeps its count");
};

const reloadJourney: ScenarioSteps = async ({ page, checkpoint }) => {
  await page.goto("/notes");
  await page.getByLabel("Title").fill("Persisted");
  await page.getByLabel("Body").fill("Survives a reload");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved note 1: Persisted");

  await page.reload();
  await expect(page.getByRole("status")).toHaveText("");
  await expect(page.getByRole("list", { name: "Saved notes" })).toContainText("Survives a reload");
  await page.goto("/reports");
  await expect(page.getByTestId("report-summary")).toHaveText("1 note, 4 words");
  await checkpoint("report after reload");
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
    scenario(noteJourney),
  );

  test(
    "notes saved to localStorage survive a reload, as in the baseline",
    { tag: "@scenario" },
    scenario(reloadJourney),
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
