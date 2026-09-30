import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { expectObfuscationPass, readBuildLog } from "@e2e/helpers/build-log.js";
import { readExpectations, smokeOf } from "@e2e/helpers/expectations.js";
import { baseURLOf, fixture } from "@e2e/helpers/registry.js";
import { expectObfuscationSignatures } from "@e2e/helpers/signatures.js";
import { runSmoke } from "@e2e/helpers/smoke.js";

const app = fixture("parcel-app");
const expectations = readExpectations(app);

test.describe("Parcel 2 packages a code-split app", { tag: "@quick" }, () => {
  test("afterpack.json pins the same seed expectations.json declares", { tag: "@node" }, () => {
    const rc = JSON.parse(readFileSync(join(app.dir, "afterpack.json"), "utf8"));
    expect(rc.seed).toBe(expectations.seed);
  });

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

  test("clicking the counter resolves and runs a lazily imported hashed chunk", async ({
    page,
  }) => {
    await runSmoke(page, baseURLOf(app), smokeOf(expectations));
  });
});

test.describe("Parcel 2 packages a code-split app, full suite", () => {
  test(
    "a classic-script target fails closed on an obfuscated content-hash placeholder",
    { tag: "@node" },
    () => {
      rmSync(join(app.dir, ".parcel-cache"), { recursive: true, force: true });
      rmSync(join(app.dir, "dist-legacy"), { recursive: true, force: true });
      let output = "";
      try {
        execFileSync("npm", ["run", "build:legacy"], {
          cwd: app.dir,
          stdio: "pipe",
          encoding: "utf8",
        });
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string };
        output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
      }
      expect(output, "the legacy classic-script target built successfully").not.toBe("");
      expect(output.replace(/\s+/g, " ")).toContain("content-hash placeholder");
      rmSync(join(app.dir, ".parcel-cache"), { recursive: true, force: true });
    },
  );
});
