import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { expectDeterministic } from "@e2e/helpers/build.js";
import { expectObfuscationPass, readBuildLog } from "@e2e/helpers/build-log.js";
import { currentFixture } from "@e2e/helpers/current.js";
import { readExpectations, smokeOf } from "@e2e/helpers/expectations.js";
import { candidateLaneTests, regionsSent } from "@e2e/helpers/lanes.js";
import { expectNoPostbuildScript, expectProtectionReceipt } from "@e2e/helpers/receipt.js";
import { baseURLOf, type Fixture } from "@e2e/helpers/registry.js";
import { type ScenarioSteps, scenario } from "@e2e/helpers/scenario.js";
import {
  expectLiteralsHidden,
  expectObfuscationSignatures,
  signatureFailures,
  unprotectedBaselineSignature,
} from "@e2e/helpers/signatures.js";
import { runSmoke } from "@e2e/helpers/smoke.js";
import {
  expectSourceMap,
  servedSourceMapProblems,
  sourceMapsUnder,
} from "@e2e/helpers/source-map.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const expectations = readExpectations(HERE);

const NAME_ERROR = "Tell us a name of at least 2 characters.";
const MESSAGE_ERROR = "Leave a message.";
const EMAIL_ERROR = "Enter an email address like ada@example.com.";
const MESSAGE = "Hello from the protected build";
const ABOUT_INTRO = "A second route, so the smoke test can navigate between pages.";

function navLink(page: Page, name: string) {
  return page.getByRole("navigation", { name: "Main" }).getByRole("link", { name });
}

const guestbookJourney: ScenarioSteps = async ({ page, checkpoint, inPlace }) => {
  await page.goto("/");
  await page.getByTestId("counter").click();
  await expect(page.getByTestId("counter")).toHaveText("clicked 1 times (odd)");
  await checkpoint("home hydrated");

  await inPlace("the About link", async () => {
    await navLink(page, "About").click();
    await expect(page.getByTestId("title")).toHaveText("About AfterPack");
  });
  await inPlace("the Guestbook link", async () => {
    await navLink(page, "Guestbook").click();
    await expect(page.getByTestId("title")).toHaveText("Guestbook");
  });

  const sign = page.getByRole("form", { name: "Sign the guestbook" });
  await sign.getByRole("button", { name: "Sign" }).click();
  await expect(sign.getByRole("alert")).toHaveText([NAME_ERROR, MESSAGE_ERROR]);
  await checkpoint("the server action rejected both fields");

  await sign.getByLabel("Name").fill("Ada");
  await sign.getByLabel("Message").fill(MESSAGE);
  await sign.getByRole("button", { name: "Sign" }).click();
  await expect(page.getByTestId("sign-status")).toHaveText("Thanks, Ada!");
  await expect(sign.getByRole("alert")).toHaveCount(0);
  await expect(page.getByTestId("signed-count")).toHaveText("1 signed");
  await checkpoint("guestbook signed");

  const subscribe = page.getByRole("form", { name: "Subscribe" });
  await subscribe.getByLabel("Email").fill("not-an-email");
  await subscribe.getByRole("button", { name: "Subscribe" }).click();
  await expect(subscribe.getByRole("alert")).toHaveText(EMAIL_ERROR);
  await subscribe.getByLabel("Email").fill("ada@example.com");
  await subscribe.getByRole("button", { name: "Subscribe" }).click();
  await expect(subscribe.getByRole("status")).toHaveText("Subscribed ada@example.com");
  await checkpoint("subscribed through the route handler");

  await inPlace("the Stats link to a next/dynamic chunk", async () => {
    await navLink(page, "Stats").click();
    await expect(page.getByTestId("stats-summary")).toHaveText("1 entry, 30 characters");
  });
  await inPlace("history back", async () => {
    await page.goBack();
    await expect(page.getByTestId("title")).toHaveText("Guestbook");
  });
  await expect(page.getByRole("list", { name: "Guestbook entries" })).toContainText(MESSAGE);
  await inPlace("history forward", async () => {
    await page.goForward();
    await expect(page.getByTestId("stats-summary")).toHaveText("1 entry, 30 characters");
  });

  await page.reload();
  await expect(page.getByTestId("stats-summary")).toHaveText("1 entry, 30 characters");
  await expect(page.getByTestId("signed-count")).toHaveText("1 signed");
  await checkpoint("stats restored from localStorage after a reload");
};

function distDirOf(app: Fixture): string {
  return join(app.dir, app.env.AFTERPACK_E2E_DIST_DIR ?? ".next");
}

async function statusOf(url: string): Promise<number> {
  return (await fetch(url)).status;
}

function testIdText(html: string, testId: string): string {
  const match = html.match(new RegExp(`data-testid="${testId}"[^>]*>([^<]*)<`));
  if (!match) throw new Error(`data-testid="${testId}" not found in the server-rendered HTML`);
  return match[1].trim();
}

async function expectGenuinelyDynamic(base: string, path: string, testId: string): Promise<void> {
  const first = testIdText(await (await fetch(`${base}${path}`)).text(), testId);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = testIdText(await (await fetch(`${base}${path}`)).text(), testId);
  expect(second, `${path} rendered identically across two requests`).not.toBe(first);
}

test.describe("Next.js 16 App Router serves a dual bundle", { tag: "@quick" }, () => {
  test("the build ran a real obfuscation pass over the shipped files", { tag: "@node" }, () => {
    const app = currentFixture();
    expectObfuscationPass(readBuildLog(app), app.name, expectations.obfuscation);
  });

  test(
    "the build applied the Counter's directive region, which lowers protection",
    { tag: "@node" },
    () => {
      expect(regionsSent(readBuildLog(currentFixture()))).toBeGreaterThan(0);
    },
  );

  test(
    "`next build` alone protected the output and left a matching receipt",
    { tag: "@node" },
    () => {
      const app = currentFixture();
      expectNoPostbuildScript(app);
      expectProtectionReceipt(app, distDirOf(app));
    },
  );

  test(
    "the shipped files carry obfuscation signatures and hide the baseline's literals",
    { tag: "@node" },
    () => {
      const app = currentFixture();
      expectLiteralsHidden(app, expectObfuscationSignatures(app));
    },
  );

  test("the same signature check rejects the unprotected baseline build", { tag: "@node" }, () => {
    const app = currentFixture();
    expect(signatureFailures(unprotectedBaselineSignature(app), app.dir)).not.toEqual([]);
  });

  test("every route, API route and interaction survives, with no hydration mismatch", async ({
    page,
  }) => {
    await runSmoke(page, baseURLOf(currentFixture()), smokeOf(expectations));
  });

  test("every source map left in the build output is a usable v3 map", { tag: "@node" }, () => {
    expectSourceMap(currentFixture());
  });

  test("the client tree serves no JS or CSS source map, and names none", { tag: "@node" }, async () => {
    const app = currentFixture();
    if (!app.baseline) throw new Error(`${app.name} has no baseline build`);
    expect(servedSourceMapProblems(join(distDirOf(app), "static"))).toEqual([]);

    const baselineMaps = sourceMapsUnder(
      join(app.dir, app.baseline.env.AFTERPACK_E2E_DIST_DIR, "static"),
    );
    expect(
      baselineMaps.filter((path) => path.endsWith(".css.map")),
      "the unprotected baseline serves no CSS map, so this check cannot fail",
    ).not.toEqual([]);
    for (const path of baselineMaps) {
      const url = `/_next/static/${path}`;
      expect(await statusOf(`${app.baseline.baseURL}${url}`), `baseline ${url}`).toBe(200);
      expect(await statusOf(`${baseURLOf(app)}${url}`), `protected ${url}`).toBe(404);
    }
  });
});

test.describe(
  "Next.js 16 App Router serves a dual bundle, as a user drives it",
  { tag: "@quick" },
  () => {
    test(
      "client navigation, both form paths, the lazy chunk and history match the baseline",
      { tag: "@scenario" },
      scenario(guestbookJourney),
    );
  },
);

candidateLaneTests();

test.describe("Next.js 16 App Router serves a dual bundle, full suite", () => {
  test(
    "the server bundle re-renders both dynamic routes per request",
    { tag: "@node" },
    async () => {
      const base = baseURLOf(currentFixture());
      await expectGenuinelyDynamic(base, "/dynamic", "dynamic-timestamp");
      await expectGenuinelyDynamic(base, "/legacy", "legacy-timestamp");
    },
  );

  test(
    "the smoke check fails on a hydration mismatch of a route it only visits, on a slow CPU",
    async ({ page, browserName }) => {
      test.skip(browserName !== "chromium", "CPU throttling is a Chromium DevTools call");
      const base = baseURLOf(currentFixture());
      const smoke = smokeOf(expectations);
      const served = await (await fetch(`${base}/about`)).text();
      expect(served, "the text this test tampers with").toContain(ABOUT_INTRO);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      await page.route(`${base}/about`, async (route) => {
        const response = await route.fetch();
        const html = await response.text();
        await route.fulfill({ response, body: html.replace(ABOUT_INTRO, "Tampered in transit.") });
      });
      const routes = [
        { path: "/about", status: 200 },
        { path: "/stats", status: 200 },
      ];
      await expect(
        runSmoke(page, base, { ...smoke, routes, apiRoutes: [], interactions: [] }),
      ).rejects.toThrow(/hydration mismatch/);
    },
  );

  test("a rebuild with the same seed repeats the output byte for byte", { tag: "@node" }, () => {
    const app = currentFixture();
    test.skip(app.name !== "next-app-webpack", "one Next leg carries the determinism rebuild");
    expectDeterministic(app);
  });
});
