import { test } from "@playwright/test";
import { expectObfuscationPass, readBuildLog } from "@e2e/helpers/build-log.js";
import { expectObfuscatedAndDeterministic } from "@e2e/helpers/build.js";
import { readExpectations, smokeOf } from "@e2e/helpers/expectations.js";
import { baseURLOf, fixture } from "@e2e/helpers/registry.js";
import { expectSourceMap } from "@e2e/helpers/source-map.js";
import { runSmoke } from "@e2e/helpers/smoke.js";

const app = fixture("webpack-react");
const expectations = readExpectations(app);

test.describe("webpack 5 bundles a React SPA", { tag: "@quick" }, () => {
  test("the build ran a real obfuscation pass over the shipped files", () => {
    expectObfuscationPass(readBuildLog(app), app.name, expectations.obfuscation);
  });

  test("the obfuscated output still renders and still reacts to a click", async ({ page }) => {
    await runSmoke(page, baseURLOf(app), smokeOf(expectations));
  });

  test("every source map shipped beside the obfuscated output is a usable v3 map", () => {
    expectSourceMap(app);
  });
});

test.describe("webpack 5 bundles a React SPA, byte-level proof", () => {
  test("the output differs from an unobfuscated build and repeats byte for byte", () => {
    expectObfuscatedAndDeterministic(app);
  });
});
