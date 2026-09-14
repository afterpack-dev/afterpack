import { createRequire } from "node:module";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { expectObfuscatedAndDeterministic } from "@e2e/helpers/build.js";
import { expectObfuscationPass, readBuildLog } from "@e2e/helpers/build-log.js";
import { readExpectations, smokeOf } from "@e2e/helpers/expectations.js";
import { baseURLOf, fixture } from "@e2e/helpers/registry.js";
import { runSmoke } from "@e2e/helpers/smoke.js";

interface ObfuscatedLibrary {
  greet: (name: string) => string;
  add: (a: number, b: number) => number;
  Counter: new () => { increment: () => number; value: number };
}

const app = fixture("rollup-lib");
const expectations = readExpectations(app);

test.describe("Rollup emits an ESM and a CJS library", { tag: "@quick" }, () => {
  test("the build ran a real obfuscation pass over the shipped files", () => {
    expectObfuscationPass(readBuildLog(app), app.name, expectations.obfuscation);
  });

  test("node can require the obfuscated CJS build and its exports still compute", () => {
    const require = createRequire(import.meta.url);
    const lib = require(join(app.dir, "dist", "cjs", "lib.cjs")) as ObfuscatedLibrary;
    expect(lib.greet("AfterPack")).toBe("Hello, AfterPack!");
    expect(lib.add(2, 3)).toBe(5);
    const counter = new lib.Counter();
    expect(counter.increment()).toBe(1);
    expect(counter.value).toBe(1);
  });

  test("a browser importing the obfuscated ESM build gets the same results", async ({ page }) => {
    await runSmoke(page, baseURLOf(app), smokeOf(expectations));
  });
});

test.describe("Rollup emits an ESM and a CJS library, byte-level proof", () => {
  test("the output differs from an unobfuscated build and repeats byte for byte", () => {
    expectObfuscatedAndDeterministic(app);
  });
});
