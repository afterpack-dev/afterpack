import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { expectObfuscationPass, readBuildLog } from "@e2e/helpers/build-log.js";
import { expectObfuscatedAndDeterministic } from "@e2e/helpers/build.js";
import { readExpectations, smokeOf } from "@e2e/helpers/expectations.js";
import { baseURLOf, fixture } from "@e2e/helpers/registry.js";
import { runSmoke } from "@e2e/helpers/smoke.js";

const app = fixture("angular-app");
const expectations = readExpectations(app);
const BROWSER_DIR = join(app.dir, "dist", "angular-fixture", "browser");

test.describe("the Angular application builder emits a browser bundle", { tag: "@quick" }, () => {
  test("the build ran a real obfuscation pass over the shipped files", () => {
    expectObfuscationPass(readBuildLog(app), app.name, expectations.obfuscation);
  });

  test("the combined Protection Map lands outside the served directory", () => {
    expect(existsSync(join(app.dir, ".afterpack", "protectionMap.html"))).toBe(true);
    const leaked = readdirSync(BROWSER_DIR).filter((name) =>
      /protectionMap|\.backup\./.test(name),
    );
    expect(leaked, "the served browser directory must carry no AfterPack artifacts").toEqual([]);
  });

  test("the obfuscated output still renders and still reacts to a click", async ({ page }) => {
    await runSmoke(page, baseURLOf(app), smokeOf(expectations));
  });
});

test.describe("the Angular application builder emits a browser bundle, byte-level proof", () => {
  test("the output differs from an unobfuscated build and repeats byte for byte", () => {
    expectObfuscatedAndDeterministic(app);
  });
});
