import { expect, type Page, type Request } from "@playwright/test";
import type { SmokeExpectations } from "./expectations.js";

const INTERACTION_TIMEOUT_MS = 15_000;
const SETTLE_TIMEOUT_MS = 5_000;
const HYDRATION_ERROR = /hydrat|Minified React error #(?:418|422|423|425)\b/i;
const WEBKIT_REFUSED_FETCH =
  /^Fetch API cannot load ([a-z][\w+.-]*):[/ ](\/\S+) due to access control checks\.$/;
const CANCELLED = /cancel|abort/i;

interface ConsoleError {
  text: string;
  refusedFetch: string | null;
  whileLeaving: boolean;
}

export interface ConsoleErrors {
  errors: ConsoleError[];
  cancelledUrls: Set<string>;
}

export function collectConsoleErrors(page: Page): ConsoleErrors {
  const collected: ConsoleErrors = { errors: [], cancelledUrls: new Set() };
  const leaving = new Set<Request>();
  const record = (text: string) => {
    const refused = WEBKIT_REFUSED_FETCH.exec(text);
    collected.errors.push({
      text,
      refusedFetch: refused ? `${refused[1]}:/${refused[2]}` : null,
      whileLeaving: leaving.size > 0,
    });
  };
  page.on("console", (message) => {
    if (message.type() === "error") record(message.text());
  });
  page.on("pageerror", (error) => record(String(error)));
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) leaving.add(request);
  });
  page.on("requestfailed", (request) => {
    leaving.delete(request);
    if (CANCELLED.test(request.failure()?.errorText ?? "")) {
      collected.cancelledUrls.add(request.url());
    }
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) leaving.clear();
  });
  return collected;
}

export function fatalConsoleErrors({ errors, cancelledUrls }: ConsoleErrors): string[] {
  return errors
    .filter(
      ({ refusedFetch, whileLeaving }) =>
        refusedFetch === null || !(whileLeaving || cancelledUrls.has(refusedFetch)),
    )
    .map(({ text }) => text);
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    (timeout) =>
      new Promise<void>((resolve) => {
        if (typeof requestIdleCallback === "function") {
          requestIdleCallback(() => resolve(), { timeout });
        } else {
          setTimeout(resolve, 50);
        }
      }),
    SETTLE_TIMEOUT_MS,
  );
}

async function contentContains(page: Page, needle: string, where: string): Promise<void> {
  await expect
    .poll(async () => (await page.content()).includes(needle), {
      timeout: INTERACTION_TIMEOUT_MS,
      message: `${where}: page content never contained ${JSON.stringify(needle)}`,
    })
    .toBe(true);
}

export async function visitRoutes(
  page: Page,
  baseURL: string,
  smoke: SmokeExpectations,
): Promise<void> {
  for (const route of smoke.routes) {
    const response = await page.goto(`${baseURL}${route.path}`);
    expect(response?.status(), `${route.path}: unexpected status`).toBe(route.status);
    for (const needle of route.textContains ?? []) {
      await contentContains(page, needle, route.path);
    }
    for (const [selector, text] of Object.entries(route.selectors ?? {})) {
      await expect(page.locator(selector), `${route.path} ${selector}`).toHaveText(text);
    }
    await settle(page);
  }
}

export async function checkApiRoutes(baseURL: string, smoke: SmokeExpectations): Promise<void> {
  for (const api of smoke.apiRoutes ?? []) {
    const response = await fetch(`${baseURL}${api.path}`);
    expect(response.status, `${api.path}: unexpected status`).toBe(api.status);
    if (api.jsonEquals !== undefined) {
      expect(await response.json(), `${api.path}: unexpected body`).toEqual(api.jsonEquals);
    }
  }
}

export async function runInteractions(
  page: Page,
  baseURL: string,
  smoke: SmokeExpectations,
): Promise<void> {
  for (const interaction of smoke.interactions ?? []) {
    await page.goto(`${baseURL}${interaction.route}`);
    await page.locator(interaction.click).click();
    for (const needle of interaction.expectTextContains ?? []) {
      await contentContains(
        page,
        needle,
        `${interaction.route} after clicking ${interaction.click}`,
      );
    }
    await settle(page);
  }
}

export function expectNoHydrationMismatch(errors: ConsoleErrors, smoke: SmokeExpectations): void {
  if (!smoke.hydration?.assertNoMismatch) return;
  expect(
    fatalConsoleErrors(errors).filter((error) => HYDRATION_ERROR.test(error)),
    "hydration mismatch (server-bundle class failure)",
  ).toEqual([]);
}

export function expectNoConsoleErrors(errors: ConsoleErrors): void {
  expect(fatalConsoleErrors(errors), "console errors while the obfuscated bundle ran").toEqual([]);
}

export async function runSmoke(
  page: Page,
  baseURL: string,
  smoke: SmokeExpectations,
): Promise<void> {
  const errors = collectConsoleErrors(page);
  await visitRoutes(page, baseURL, smoke);
  await checkApiRoutes(baseURL, smoke);
  await runInteractions(page, baseURL, smoke);
  expectNoHydrationMismatch(errors, smoke);
  expectNoConsoleErrors(errors);
}
