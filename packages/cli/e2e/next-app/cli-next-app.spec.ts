import { test } from "@playwright/test";
import { expectObfuscationPass, readBuildLog } from "@e2e/helpers/build-log.js";
import { readExpectations, smokeOf } from "@e2e/helpers/expectations.js";
import { expectVerifyPasses } from "@e2e/helpers/receipt.js";
import { baseURLOf, fixture } from "@e2e/helpers/registry.js";
import { expectRestoreUndoesRenames } from "@e2e/helpers/restore.js";
import { expectObfuscationSignatures } from "@e2e/helpers/signatures.js";
import { runSmoke } from "@e2e/helpers/smoke.js";
import { hashedNamesTest } from "@e2e/helpers/hashed-names.js";

const app = fixture("cli-next-app");
const expectations = readExpectations(app);

test.describe("the CLI renames a Next.js build's content-hashed chunks", { tag: "@quick" }, () => {
  test("the build ran a real obfuscation pass over the shipped files", { tag: "@node" }, () => {
    expectObfuscationPass(readBuildLog(app), app.name, expectations.obfuscation);
  });

  test(
    "the shipped chunks carry obfuscation signatures, not mere minification",
    { tag: "@node" },
    () => {
      expectObfuscationSignatures(app);
    },
  );

  test("`afterpack verify .next/static/chunks` passes the renamed tree", { tag: "@node" }, () => {
    expectVerifyPasses(app, ".next/static/chunks");
  });

  test("next start serves, hydrates and runs the renamed chunks", async ({ page }) => {
    await runSmoke(page, baseURLOf(app), smokeOf(expectations));
  });
});

test.describe("`afterpack restore` undoes the renames", () => {
  test(
    "restore gives back the plain .next tree byte for byte, and verify passes a deploy copy",
    { tag: "@node" },
    () => {
      expectRestoreUndoesRenames(app, ".next/static/chunks", ".next");
    },
  );
});

hashedNamesTest();
