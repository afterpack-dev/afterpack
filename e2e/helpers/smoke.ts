import { expect, type Page } from "@playwright/test";
import type { SmokeExpectations } from "./expectations.js";

const INTERACTION_TIMEOUT_MS = 15_000;

export function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  return errors;
}

async function contentContainsWithin(page: Page, needle: string, timeoutMs: number): Promise<void> {
  await expect
    .poll(async () => (await page.content()).includes(needle), {
      timeout: timeoutMs,
      message: `page content never contained ${JSON.stringify(needle)}`,
    })
    .toBe(true);
}

export async function visitRoutes(
  page: Page,
  baseURL: string,
  smoke: SmokeExpectations,
): Promise<void> {
  for (const route of smoke.routes) {
    const response = await page.goto(`${baseURL}${route.path}`, { waitUntil: "networkidle" });
    expect(response?.status(), `${route.path}: unexpected status`).toBe(route.status);
    const content = await page.content();
    for (const needle of route.textContains ?? []) {
      expect(content, `${route.path}: missing text ${JSON.stringify(needle)}`).toContain(needle);
    }
    for (const [selector, text] of Object.entries(route.selectors ?? {})) {
      await expect(page.locator(selector), `${route.path} ${selector}`).toHaveText(text);
    }
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
    await page.goto(`${baseURL}${interaction.route}`, { waitUntil: "networkidle" });
    await page.locator(interaction.click).click();
    for (const needle of interaction.expectTextContains ?? []) {
      await contentContainsWithin(page, needle, INTERACTION_TIMEOUT_MS);
    }
  }
}

export function expectNoHydrationMismatch(errors: string[], smoke: SmokeExpectations): void {
  if (!smoke.hydration?.assertNoMismatch) return;
  expect(
    errors.filter((error) => /hydrat/i.test(error)),
    "hydration mismatch (server-bundle class failure)",
  ).toEqual([]);
}

export function expectNoConsoleErrors(errors: string[]): void {
  expect(errors, "console errors while the obfuscated bundle ran").toEqual([]);
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
