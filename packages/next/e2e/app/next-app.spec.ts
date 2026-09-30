import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { expectDeterministic } from "@e2e/helpers/build.js";
import { expectObfuscationPass, readBuildLog } from "@e2e/helpers/build-log.js";
import { currentFixture } from "@e2e/helpers/current.js";
import { readExpectations, smokeOf } from "@e2e/helpers/expectations.js";
import { expectNoPostbuildScript, expectProtectionReceipt } from "@e2e/helpers/receipt.js";
import { baseURLOf, type Fixture } from "@e2e/helpers/registry.js";
import {
  expectLiteralsHidden,
  expectObfuscationSignatures,
  signatureFailures,
  unprotectedBaselineSignature,
} from "@e2e/helpers/signatures.js";
import { runSmoke } from "@e2e/helpers/smoke.js";
import { expectSourceMap } from "@e2e/helpers/source-map.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const expectations = readExpectations(HERE);

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
  test("the build ran a real obfuscation pass over the shipped files", { tag: "@node" }, () => {
    const app = currentFixture();
    expectObfuscationPass(readBuildLog(app), app.name, expectations.obfuscation);
  });

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
});

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

  test("a rebuild with the same seed repeats the output byte for byte", { tag: "@node" }, () => {
    const app = currentFixture();
    test.skip(app.name !== "next-app-webpack", "one Next leg carries the determinism rebuild");
    expectDeterministic(app);
  });
});
