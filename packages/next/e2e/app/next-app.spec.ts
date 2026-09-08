import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { expectObfuscationPass, readBuildLog } from "../../../../e2e/helpers/build-log.js";
import { expectObfuscatedAndDeterministic } from "../../../../e2e/helpers/build.js";
import { readExpectations, smokeOf } from "../../../../e2e/helpers/expectations.js";
import { expectNoPostbuildScript, expectProtectionReceipt } from "../../../../e2e/helpers/receipt.js";
import { baseURLOf, type Fixture, fixture } from "../../../../e2e/helpers/registry.js";
import { runSmoke } from "../../../../e2e/helpers/smoke.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const expectations = readExpectations(HERE);

function current(): Fixture {
  return fixture(test.info().project.name);
}

function distDirOf(app: Fixture): string {
  return join(app.dir, app.env.AFTERPACK_E2E_DIST_DIR ?? ".next");
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
  test("the build ran a real obfuscation pass over the shipped files", () => {
    const app = current();
    expectObfuscationPass(readBuildLog(app), app.name, expectations.obfuscation);
  });

  test("`next build` alone protected the output and left a matching receipt", () => {
    const app = current();
    expectNoPostbuildScript(app);
    expectProtectionReceipt(app, distDirOf(app));
  });

  test("every route, API route and interaction survives, with no hydration mismatch", async ({
    page,
  }) => {
    await runSmoke(page, baseURLOf(current()), smokeOf(expectations));
  });
});

test.describe("Next.js 16 App Router serves a dual bundle, byte-level proof", () => {
  test("the server bundle re-renders both dynamic routes per request", async () => {
    const base = baseURLOf(current());
    await expectGenuinelyDynamic(base, "/dynamic", "dynamic-timestamp");
    await expectGenuinelyDynamic(base, "/legacy", "legacy-timestamp");
  });

  test("the output differs from an unobfuscated build and repeats byte for byte", () => {
    expectObfuscatedAndDeterministic(current());
  });
});
