import { expect, type Page } from "@playwright/test";
import type { ScenarioSteps } from "./scenario.js";

export const TITLE_ERROR = "Give the note a title of at least 3 characters.";
export const BODY_ERROR = "Keep the note under 140 characters.";

export function navLink(page: Page, name: string) {
  return page.getByRole("navigation", { name: "Main" }).getByRole("link", { name });
}

export function notesJourney(homeTitle: string): ScenarioSteps {
  return async ({ page, checkpoint, inPlace }) => {
    await page.goto("/");
    await expect(page.getByTestId("title")).toHaveText(homeTitle);
    await page.getByTestId("counter").click();
    await page.getByTestId("counter").click();
    await expect(page.getByTestId("counter")).toHaveText("count is 2 (even)");

    await inPlace("the Notes link", async () => {
      await navLink(page, "Notes").click();
      await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible();
    });
    await expect(page).toHaveURL(/\/notes\/?$/);

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
      await navLink(page, "Reports").click();
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
      await navLink(page, "Home").click();
      await expect(page.getByTestId("counter")).toHaveText("count is 2 (even)");
    });
    await checkpoint("home keeps its count");
  };
}

export const notesReloadJourney: ScenarioSteps = async ({ page, checkpoint }) => {
  await page.goto("/notes");
  await page.getByLabel("Title").fill("Persisted");
  await page.getByLabel("Body").fill("Survives a reload");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved note 1: Persisted");
  await checkpoint("note saved before the reload");

  await page.reload();
  await expect(page.getByRole("status")).toHaveText("");
  await expect(page.getByRole("list", { name: "Saved notes" })).toContainText("Survives a reload");
  await checkpoint("notes restored after the reload");
  await page.goto("/reports");
  await expect(page.getByTestId("report-summary")).toHaveText("1 note, 4 words");
  await checkpoint("report after reload");
};
