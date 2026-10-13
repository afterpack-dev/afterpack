import { test } from "@playwright/test";
import { expectObfuscationPass, readBuildLog } from "@e2e/helpers/build-log.js";
import { readExpectations, smokeOf } from "@e2e/helpers/expectations.js";
import { expectVerifyPasses } from "@e2e/helpers/receipt.js";
import { baseURLOf, fixture } from "@e2e/helpers/registry.js";
import { expectRestoreUndoesRenames } from "@e2e/helpers/restore.js";
import { expectObfuscationSignatures } from "@e2e/helpers/signatures.js";
import { runSmoke } from "@e2e/helpers/smoke.js";
import { hashedNamesTest } from "@e2e/helpers/hashed-names.js";

const app = fixture("cli-vite-app");
const expectations = readExpectations(app);

test.describe("the CLI renames a Vite build's content-hashed chunks", { tag: "@quick" }, () => {
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

  test("`afterpack verify dist` passes the renamed tree", { tag: "@node" }, () => {
    expectVerifyPasses(app, "dist");
  });

  test("the renamed output still renders and loads its lazy chunks", async ({ page }) => {
    await runSmoke(page, baseURLOf(app), smokeOf(expectations));
  });
});

test.describe("`afterpack restore` undoes the renames", () => {
  test(
    "restore gives back the plain Vite build byte for byte, and verify passes a deploy copy",
    { tag: "@node" },
    () => {
      expectRestoreUndoesRenames(app, "dist");
    },
  );
});

hashedNamesTest();
