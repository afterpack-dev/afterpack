import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { expectObfuscationPass, readBuildLog } from "@e2e/helpers/build-log.js";
import { currentFixture } from "@e2e/helpers/current.js";
import { readExpectations, smokeOf } from "@e2e/helpers/expectations.js";
import { expectNoPostbuildScript, expectProtectionReceipt } from "@e2e/helpers/receipt.js";
import { baseURLOf, type Fixture } from "@e2e/helpers/registry.js";
import { expectObfuscationSignatures } from "@e2e/helpers/signatures.js";
import { runSmoke } from "@e2e/helpers/smoke.js";

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

test.describe("Next.js 16 with a Pages-only app", { tag: "@quick" }, () => {
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
    "the shipped files carry obfuscation signatures, not mere minification",
    { tag: "@node" },
    () => {
      expectObfuscationSignatures(currentFixture());
    },
  );

  test("every route, API route and interaction survives, with no hydration mismatch", async ({
    page,
  }) => {
    await runSmoke(page, baseURLOf(currentFixture()), smokeOf(expectations));
  });
});

test.describe("Next.js 16 with a Pages-only app, full suite", () => {
  test(
    "getServerSideProps re-runs out of the obfuscated server bundle per request",
    { tag: "@node" },
    async () => {
      const base = baseURLOf(currentFixture());
      const first = testIdText(await (await fetch(`${base}/ssr`)).text(), "ssr-timestamp");
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = testIdText(await (await fetch(`${base}/ssr`)).text(), "ssr-timestamp");
      expect(second, "/ssr rendered identically across two requests").not.toBe(first);
    },
  );
});
