import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { processBatch as ProcessBatch, version as Version } from "@afterpack/core";
import type { CoreConfig, ObfuscationEngine } from "@afterpack/integration-utils";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/run.js";

const { processBatch, version } = createRequire(import.meta.url)("@afterpack/core") as {
  processBatch: typeof ProcessBatch;
  version: typeof Version;
};

function recordingEngine(onConfig: (config: CoreConfig) => void): ObfuscationEngine {
  return {
    version,
    processBatch: (files, config, buildContext) => {
      onConfig(config);
      return processBatch(files, config, buildContext);
    },
  };
}

const APP = `export function computeOrderTotal(items) {
  let total = 0;
  for (const item of items) {
    total += item.price * item.quantity;
  }
  return total;
}
console.log(computeOrderTotal([{ price: 2, quantity: 3 }]));
`;

const VENDOR = `export const VENDOR_BUILD = "untouched";\n`;

const EXCLUDE_VENDOR = {
  paths: { exclude: ["**/vendor.js"] },
  inflation: { max: "unlimited" },
};

const roots: string[] = [];

async function build(configFile: object | null, env: Record<string, string>, flags: string[]) {
  const root = mkdtempSync(join(tmpdir(), "afterpack-seam-"));
  roots.push(root);
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "app.js"), APP);
  writeFileSync(join(dist, "vendor.js"), VENDOR);
  if (configFile) writeFileSync(join(root, "afterpack.json"), JSON.stringify(configFile));

  const errors: string[] = [];
  const configs: CoreConfig[] = [];
  const code = await run({
    argv: ["dist", "--telemetry.enabled=false", "--protectionMap.enabled=false", ...flags],
    cwd: root,
    engine: recordingEngine((config) => configs.push(config)),
    logger: { log: () => {}, error: (m) => errors.push(m), warn: () => {} },
    version: "9.9.9",
    env,
  });
  return {
    code,
    app: readFileSync(join(dist, "app.js"), "utf8"),
    vendor: readFileSync(join(dist, "vendor.js"), "utf8"),
    errors,
    engineConfig: configs.length > 0 ? configs[0] : null,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("afterpack.json + AFTERPACK_ + --flag, through processBatch to a real build", () => {
  it("puts every place's value on the wire and builds successfully from it", async () => {
    const built = await build(EXCLUDE_VENDOR, { AFTERPACK_seed: "424242" }, ["--preset=hard"]);

    expect(built.errors).toEqual([]);
    expect(built.code).toBe(0);
    expect(built.engineConfig).toMatchObject({
      paths: { exclude: ["**/vendor.js"] },
      inflation: { max: "unlimited" },
      seed: 424242,
      preset: "hard",
    });

    expect(built.app).not.toBe(APP);
    expect(built.app).not.toContain("let total = 0");
    expect(built.vendor).toBe(VENDOR);
  }, 60_000);

  it("proves each effect against a build without that place's value", async () => {
    const withExclude = await build(EXCLUDE_VENDOR, {}, ["--preset=hard", "--seed=424242"]);
    const noExclude = await build(null, {}, ["--preset=hard", "--seed=424242"]);
    expect(noExclude.code).toBe(0);
    expect(withExclude.vendor).toBe(VENDOR);
    expect(noExclude.vendor).not.toBe(VENDOR);

    const minified = await build(null, {}, ["--preset=minify", "--seed=424242"]);
    expect(minified.code).toBe(0);
    expect(noExclude.app.length).toBeGreaterThan(minified.app.length * 3);

    const otherSeed = await build(null, { AFTERPACK_seed: "999001" }, ["--preset=hard"]);
    expect(otherSeed.code).toBe(0);
    expect(otherSeed.app).not.toBe(noExclude.app);
  }, 60_000);

  it("refuses the build from every place rather than reaching the engine at all", async () => {
    const fromFile = await build({ preset: "hardened" }, {}, []);
    expect(fromFile.code).toBe(64);
    expect(fromFile.errors.join("\n")).toContain("expected one of: minify, light, medium");

    const fromEnv = await build(null, { AFTERPACK_PRESET: "hard" }, []);
    expect(fromEnv.code).toBe(64);
    expect(fromEnv.errors.join("\n")).toContain("write `AFTERPACK_preset`");

    const fromFlag = await build(null, {}, ["--strings=on"]);
    expect(fromFlag.code).toBe(64);
    expect(fromFlag.errors.join("\n")).toContain("`strings.encode`");

    for (const refused of [fromFile, fromEnv, fromFlag]) {
      expect(refused.engineConfig).toBeNull();
      expect(refused.app).toBe(APP);
    }
  }, 30_000);
});
