import { test } from "@playwright/test";
import { type Fixture, fixture } from "./registry.js";

export function currentFixture(): Fixture {
  const name = test.info().project.metadata.fixture;
  if (typeof name !== "string") throw new Error("this Playwright project names no e2e fixture");
  return fixture(name);
}
