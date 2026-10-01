import { join } from "node:path";
import { test } from "@playwright/test";
import { expectObfuscationPass, readBuildLog } from "@e2e/helpers/build-log.js";
import { readExpectations, smokeOf } from "@e2e/helpers/expectations.js";
import { expectNoPostbuildScript, expectProtectionReceipt } from "@e2e/helpers/receipt.js";
import { baseURLOf, fixture } from "@e2e/helpers/registry.js";
import { expectObfuscationSignatures } from "@e2e/helpers/signatures.js";
import { runSmoke } from "@e2e/helpers/smoke.js";

const app = fixture("next-static-export");
const expectations = readExpectations(app);

test.describe("Next.js 16 exports a fully static site", { tag: "@quick" }, () => {
  test("the build ran a real obfuscation pass over the shipped files", { tag: "@node" }, () => {
    expectObfuscationPass(readBuildLog(app), app.name, expectations.obfuscation);
  });

  test(
    "the shipped files carry obfuscation signatures, not mere minification",
    { tag: "@node" },
    () => {
      expectObfuscationSignatures(app);
    },
  );

  test(
    "the export carried the obfuscated chunks rather than a cleartext copy",
    { tag: "@node" },
    () => {
      expectNoPostbuildScript(app);
      expectProtectionReceipt(app, join(app.dir, ".next"), join(app.dir, "out", "_next"));
    },
  );

  test("the exported site renders, hydrates and reacts to a click", async ({ page }) => {
    await runSmoke(page, baseURLOf(app), smokeOf(expectations));
  });
});
