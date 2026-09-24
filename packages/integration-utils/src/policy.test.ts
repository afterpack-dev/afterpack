import { describe, expect, it } from "vitest";
import {
  buildEngineConfig,
  DEFAULT_PRESET,
  detectProduction,
  effectiveComplexityTarget,
  PRESETS,
  presetTarget,
  resolveReportPolicy,
  resolveSourceMapEnabled,
} from "./policy.js";

function target(cfg: ReturnType<typeof buildEngineConfig>): number | undefined {
  return cfg.complexity;
}

describe("detectProduction", () => {
  it("is false in a bare dev env", () => {
    expect(detectProduction({})).toBe(false);
  });
  it("is true for NODE_ENV=production, CI=true, or an explicit hint", () => {
    expect(detectProduction({ NODE_ENV: "production" })).toBe(true);
    expect(detectProduction({ CI: "true" })).toBe(true);
    expect(detectProduction({}, { build: { mode: "production" } })).toBe(true);
  });
  it("an explicit build.mode wins over the environment", () => {
    expect(detectProduction({ CI: "true" }, { build: { mode: "development" } })).toBe(false);
    expect(detectProduction({ NODE_ENV: "production" }, { build: { mode: "development" } })).toBe(
      false,
    );
  });
});

describe("resolveReportPolicy — PM couples to sourcemap presence, not dev/prod", () => {
  it("bundler sourcemap present: PM ON (opt-out), in dev OR prod", () => {
    const dev = resolveReportPolicy({}, {}, { hasBundlerSourcemap: true });
    expect(dev.protectionMap).toBe(true);
    expect(dev.autoEnableBundlerSourcemap).toBe(false);
    const prod = resolveReportPolicy({ NODE_ENV: "production" }, {}, { hasBundlerSourcemap: true });
    expect(prod.protectionMap).toBe(true);
    expect(prod.protectionMapInProd).toBe(true);
  });

  it("no bundler sourcemap: PM OFF (opt-in), in dev OR prod", () => {
    expect(resolveReportPolicy({}, {}, { hasBundlerSourcemap: false }).protectionMap).toBe(false);
    expect(resolveReportPolicy({}, {}).protectionMap).toBe(false);
    expect(
      resolveReportPolicy({ NODE_ENV: "production" }, {}, { hasBundlerSourcemap: false })
        .protectionMap,
    ).toBe(false);
  });

  it("explicit protectionMap:true forces ON even with no map, and asks to auto-enable it", () => {
    const p = resolveReportPolicy(
      {},
      { protectionMap: { enabled: true } },
      { hasBundlerSourcemap: false },
    );
    expect(p.protectionMap).toBe(true);
    expect(p.autoEnableBundlerSourcemap).toBe(true);
    const q = resolveReportPolicy(
      {},
      { protectionMap: { enabled: true } },
      { hasBundlerSourcemap: true },
    );
    expect(q.autoEnableBundlerSourcemap).toBe(false);
  });

  it("explicit protectionMap:false forces OFF even with a map present", () => {
    const p = resolveReportPolicy(
      {},
      { protectionMap: { enabled: false } },
      { hasBundlerSourcemap: true },
    );
    expect(p.protectionMap).toBe(false);
    expect(p.protectionMapInProd).toBe(false);
  });

  it("sourceMappingURL + backup keep their dev/prod defaults (independent of PM)", () => {
    const dev = resolveReportPolicy({}, {});
    expect(dev.emitSourceMappingURL).toBe(true);
    expect(dev.sourceMap).toBe(true);
    expect(dev.backup).toBe(true);
    const prod = resolveReportPolicy({ NODE_ENV: "production" }, {});
    expect(prod.emitSourceMappingURL).toBe(false);
    expect(prod.sourceMap).toBe(false);
    expect(prod.backup).toBe(true);
    expect(resolveReportPolicy({ CI: "true" }, {}).emitSourceMappingURL).toBe(false);
  });

  it("inPlaceOutput defaults backup OFF (it would ship the original source), but explicit backup:true wins", () => {
    expect(resolveReportPolicy({}, {}, { inPlaceOutput: true }).backup).toBe(false);
    expect(
      resolveReportPolicy({ NODE_ENV: "production" }, {}, { inPlaceOutput: true }).backup,
    ).toBe(false);
    expect(
      resolveReportPolicy({}, { build: { backup: true } }, { inPlaceOutput: true }).backup,
    ).toBe(true);
    expect(resolveReportPolicy({}, {}).backup).toBe(true);
  });

  it("force-enabling PM in prod flags the loud-warning path", () => {
    const p = resolveReportPolicy(
      { NODE_ENV: "production" },
      {
        protectionMap: { enabled: true },
        sourceMap: { enabled: false, emitUrl: true },
        build: { backup: false },
      },
    );
    expect(p.protectionMap).toBe(true);
    expect(p.emitSourceMappingURL).toBe(true);
    expect(p.backup).toBe(false);
    expect(p.sourceMap).toBe(false);
    expect(p.protectionMapInProd).toBe(true);
  });
});

describe("resolveSourceMapEnabled — auto = on iff input map exists", () => {
  it("auto follows the presence of an input map", () => {
    expect(resolveSourceMapEnabled(undefined, true)).toBe(true);
    expect(resolveSourceMapEnabled(undefined, false)).toBe(false);
  });
  it("an explicit override wins either way", () => {
    expect(resolveSourceMapEnabled(true, false)).toBe(true);
    expect(resolveSourceMapEnabled(false, true)).toBe(false);
  });
});

describe("buildEngineConfig", () => {
  it("wires sourceMap/inputSourceMap/filePath/report from the policy (dev, with input map)", () => {
    const policy = resolveReportPolicy({}, {}, { hasBundlerSourcemap: true });
    const cfg = buildEngineConfig({
      filePath: "out/main.js",
      inputSourceMap: '{"version":3}',
      policy,
      seed: 7,
    });
    expect(cfg.filePath).toBe("out/main.js");
    expect(cfg.seed).toBe(7);
    expect(cfg.protectionMap.enabled).toBe(true);
    expect(cfg.sourceMap.enabled).toBe(true);
    expect(cfg.sourceMap.sourcesContent).toBe(true);
    expect(cfg.inputSourceMap).toBe('{"version":3}');
  });

  it("no input map -> sourceMap.enabled auto-off and no inputSourceMap key", () => {
    const policy = resolveReportPolicy({}, {});
    const cfg = buildEngineConfig({ filePath: "out/main.js", inputSourceMap: null, policy });
    expect(cfg.sourceMap.enabled).toBe(false);
    expect("inputSourceMap" in cfg).toBe(false);
  });

  it("prod: protectionMap OFF, sourcesContent OFF, and map OFF even with an input map", () => {
    const policy = resolveReportPolicy({ NODE_ENV: "production" }, {});
    const cfg = buildEngineConfig({
      filePath: "out/main.js",
      inputSourceMap: '{"version":3}',
      policy,
    });
    expect(cfg.protectionMap.enabled).toBe(false);
    expect(cfg.sourceMap.sourcesContent).toBe(false);
    expect(cfg.sourceMap.enabled).toBe(false);
  });

  it("explicit sourceMap:true forces the engine map on even with no input map", () => {
    const policy = resolveReportPolicy({}, { sourceMap: { enabled: true } });
    const cfg = buildEngineConfig({ filePath: "f.js", inputSourceMap: null, policy });
    expect(cfg.sourceMap.enabled).toBe(true);
  });

  it("merges the typed engine subset over the policy-derived defaults", () => {
    const policy = resolveReportPolicy({}, {});
    const cfg = buildEngineConfig({
      filePath: "f.js",
      inputSourceMap: null,
      policy,
      engine: { strings: { minLength: 4 }, paths: { exclude: ["vendor/**"] } },
    });
    expect(cfg.strings).toEqual({ minLength: 4 });
    expect(cfg.paths).toEqual({ exclude: ["vendor/**"] });
  });
});

describe("buildEngineConfig — preset bundle vs numeric complexity target", () => {
  const policy = resolveReportPolicy({}, {});

  it("no preset and no complexity -> LIGHT (target 2.0 + string floor ON)", () => {
    expect(DEFAULT_PRESET).toBe("light");
    const cfg = buildEngineConfig({ policy, seed: 1 });
    expect(target(cfg)).toBe(2);
  });

  it('preset "minify" -> minify-only: no target on the wire', () => {
    const cfg = buildEngineConfig({ policy, preset: "minify" });
    expect(cfg.preset).toBe("minify");
    expect(target(cfg)).toBeUndefined();
  });

  it("complexity 0 -> minify-only (target 0) with no preset", () => {
    const cfg = buildEngineConfig({ policy, complexity: 0 });
    expect(cfg.preset).toBeUndefined();
    expect(target(cfg)).toBe(0);
  });

  it("a preset alone rides as `preset`, leaving the target for the engine to resolve", () => {
    for (const preset of PRESETS) {
      const cfg = buildEngineConfig({ policy, preset });
      expect(cfg.preset).toBe(preset);
      expect(target(cfg)).toBeUndefined();
    }
  });

  it("a bare numeric target sends NO preset, keeping the target-derived ladders", () => {
    const cfg = buildEngineConfig({ policy, complexity: 40 });
    expect(cfg.preset).toBeUndefined();
    expect(target(cfg)).toBe(40);
  });

  it("preset + complexity overrides only the target, keeping the rest of the bundle", () => {
    const cfg = buildEngineConfig({ policy, preset: "hard", complexity: 40 });
    expect(cfg.preset).toBe("hard");
    expect(target(cfg)).toBe(40);
  });

  it("presets map to the same targets as the engine's Preset ladder", () => {
    expect(presetTarget("minify")).toBe(0);
    expect(presetTarget("light")).toBe(2);
    expect(presetTarget("medium")).toBe(8);
    expect(presetTarget("hard")).toBe(25);
    expect(presetTarget("extreme")).toBe(80);
  });

  it("resolves an explicit target over the preset ladder over the light default", () => {
    expect(effectiveComplexityTarget(undefined, undefined)).toBe(2);
    expect(effectiveComplexityTarget("hard", undefined)).toBe(25);
    expect(effectiveComplexityTarget("hard", 40)).toBe(40);
    expect(effectiveComplexityTarget("extreme", 0)).toBe(0);
  });

  it("the LIGHT default rides through to the engine config object", () => {
    const cfg = buildEngineConfig({ policy, seed: 3 });
    expect(cfg.complexity).toBe(2);
    expect(cfg.strings).toBeUndefined();
    expect(cfg.preset).toBeUndefined();
  });

  it("lets an explicitly-configured complexity beat the preset's", () => {
    const cfg = buildEngineConfig({
      policy,
      preset: "hard",
      engine: { complexity: 0 },
    });
    expect(cfg.complexity).toBe(0);
    expect(cfg.preset).toBe("hard");
  });
});
