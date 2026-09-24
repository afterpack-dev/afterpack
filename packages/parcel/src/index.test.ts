import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AfterpackConfig,
  toEngineConfig,
  toPluginOptions,
  validateConfig,
} from "@afterpack/integration-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __reset, __setProcessResult, engineCalls } from "../../../test/core-fake.js";
import { resetBuildSessions } from "../../integration-utils/src/seed.js";
import afterpackParcel from "./index.js";

const PLUGIN_CONFIG = Symbol.for("parcel-plugin-config");

interface OptimizeArgs {
  bundle: unknown;
  contents: unknown;
  map: unknown;
  options: unknown;
  logger: unknown;
  config: unknown;
  getSourceMapReference: unknown;
}
interface PluginHandlers {
  loadConfig(arg: { config: unknown; options: unknown }): Promise<unknown>;
  optimize(arg: OptimizeArgs): Promise<{ contents: string; map: unknown }>;
}

function pluginConfig(raw: AfterpackConfig = {}): unknown {
  const validated = validateConfig(raw, "afterpack.json");
  expect(validated.issues).toEqual([]);
  return {
    options: toPluginOptions(validated.config),
    engineConfig: toEngineConfig(validated.config),
  };
}

const handlers = (afterpackParcel as unknown as Record<symbol, PluginHandlers>)[PLUGIN_CONFIG];

let root: string;
let distDir: string;
let warnings: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "afterpack-parcel-test-"));
  distDir = join(root, "dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(root, ".gitignore"), "");
  warnings = [];
  resetBuildSessions();
  __reset();
  __setProcessResult((input) => ({ code: `OBF:${input}`, sourceMap: null, protectionMap: null }));
});
afterEach(() => {
  resetBuildSessions();
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

interface BundleOverrides {
  name?: string;
  displayName?: string;
  publicId?: string;
  type?: string;
  shouldOptimize?: boolean;
  sourceMap?: unknown;
}

function fakeBundle(o: BundleOverrides = {}): unknown {
  return {
    name: o.name ?? "app.HASH_REF_1111111111111111.js",
    displayName: o.displayName ?? "app.[hash].js",
    publicId: o.publicId ?? "aBcDe",
    type: o.type ?? "js",
    env: { shouldOptimize: o.shouldOptimize ?? true, sourceMap: o.sourceMap ?? {} },
    target: { distDir },
  };
}

function fakeMap(json: unknown): unknown {
  return { stringify: async () => JSON.stringify(json) };
}

interface RunOverrides {
  bundle?: unknown;
  contents?: string;
  map?: unknown;
  config?: AfterpackConfig;
  env?: Record<string, string | undefined>;
  mode?: string;
  sourceMapReference?: string | null;
}

function run(o: RunOverrides = {}): Promise<{ contents: string; map: unknown }> {
  return handlers.optimize({
    bundle: o.bundle ?? fakeBundle(),
    contents: o.contents ?? "export const a = 1;",
    map: o.map ?? null,
    config: pluginConfig(o.config ?? {}),
    logger: {
      warn: ({ message }: { message: string }) => warnings.push(message),
      info: () => {},
    },
    options: {
      projectRoot: root,
      mode: o.mode ?? "production",
      env: o.env ?? {},
      inputFS: {},
    },
    getSourceMapReference: async () => o.sourceMapReference ?? "app.js.map",
  });
}

describe("afterpack parcel optimizer", () => {
  it("obfuscates the bundle IN MEMORY, writing nothing into the dist dir", async () => {
    const result = await run();

    expect(result.contents).toBe("OBF:export const a = 1;");
    expect(engineCalls.map((c) => c.input)).toEqual(["export const a = 1;"]);
    expect(readdirSync(distDir)).toEqual([]);
  });

  it("never writes a `.backup.` even when asked, and says so rather than no-opping", async () => {
    await run({ config: { build: { backup: true } } });

    expect(readdirSync(distDir)).toEqual([]);
    expect(existsSync(join(root, "app.HASH_REF_1111111111111111.js"))).toBe(false);
    expect(warnings.join("\n")).toContain("backup:true is not available");
  });

  it("feeds the LIVE map as sourceMap instead of probing disk", async () => {
    const map = { version: 3, sources: ["src/a.js"], mappings: "AAAA", sourcesContent: ["x"] };
    await run({ map: fakeMap(map) });

    expect(JSON.parse(engineCalls[0].sourceMap as string)).toEqual(map);
  });

  it("passes no input map when the bundle carries none", async () => {
    await run();
    expect(engineCalls[0].sourceMap).toBeUndefined();
  });

  it("leaves a non-JS bundle untouched", async () => {
    const result = await run({ bundle: fakeBundle({ type: "css" }), contents: ".x{}" });

    expect(result.contents).toBe(".x{}");
    expect(engineCalls).toHaveLength(0);
  });

  it("skips a bundle the target does not optimize (Parcel's dev-mode boundary)", async () => {
    const result = await run({ bundle: fakeBundle({ shouldOptimize: false }) });

    expect(result.contents).toBe("export const a = 1;");
    expect(engineCalls).toHaveLength(0);
  });

  it("does nothing when build.autorun is disabled via the option", async () => {
    await run({ config: { build: { autorun: false } } });
    expect(engineCalls).toHaveLength(0);
  });

  it("does nothing when AFTERPACK_build_autorun=false rides Parcel's env into loadConfig", async () => {
    const loaded = await handlers.loadConfig({
      config: { getConfigFrom: async () => null },
      options: { projectRoot: root, env: { AFTERPACK_build_autorun: "false" } },
    });
    await handlers.optimize({
      bundle: fakeBundle(),
      contents: "export const a = 1;",
      map: null,
      config: loaded,
      logger: { warn: () => {}, info: () => {} },
      options: { projectRoot: root, mode: "production", env: {}, inputFS: {} },
      getSourceMapReference: async () => "app.js.map",
    });
    expect(engineCalls).toHaveLength(0);
  });

  it("fails the build when the engine reports an error diagnostic", async () => {
    __setProcessResult(() => ({
      code: "",
      diagnostics: [{ severity: "error", message: "boom" }],
    }));

    await expect(run()).rejects.toThrow(/boom/);
  });

  it("forwards a hand-authored regions array into the shared engine config", async () => {
    await run({ config: { regions: [{ start: 0, end: 5, target: 9, floor: false }] } });

    expect(engineCalls[0].config.regions).toEqual([{ start: 0, end: 5, target: 9, floor: false }]);
  });
});

describe("Parcel content-hash placeholders", () => {
  const CHUNK = 'const u={"a":"lazy.HASH_REF_2222222222222222.js"};';

  it("FAILS the build when the engine obfuscates a placeholder away", async () => {
    __setProcessResult(() => ({ code: "const u=decode(0x1);", sourceMap: null }));

    await expect(run({ contents: CHUNK })).rejects.toThrow(
      /content-hash placeholder\(s\).*HASH_REF_2222222222222222/s,
    );
  });

  it("passes when every placeholder survives", async () => {
    const result = await run({ contents: CHUNK });
    expect(result.contents).toContain("HASH_REF_2222222222222222");
  });

  it("does NOT count the bundle's own sourceMappingURL reference as lost", async () => {
    const withComment = `${CHUNK}\n//# sourceMappingURL=app.HASH_REF_3333333333333333.js.map\n`;
    __setProcessResult(() => ({ code: CHUNK, sourceMap: null }));

    const result = await run({ contents: withComment });
    expect(result.contents).toBe(CHUNK);
  });
});

describe("build seed across a target's bundles", () => {
  const seedsSoFar = (): unknown[] => engineCalls.map((c) => c.config.seed);

  it("gives every bundle of ONE build the SAME freshly-drawn seed", async () => {
    await run({ bundle: fakeBundle({ displayName: "app.[hash].js", publicId: "aaa" }) });
    await run({ bundle: fakeBundle({ displayName: "lazy.[hash].js", publicId: "bbb" }) });
    await run({ bundle: fakeBundle({ displayName: "vendor.[hash].js", publicId: "ccc" }) });

    const seeds = seedsSoFar();
    expect(seeds).toHaveLength(3);
    expect(new Set(seeds).size).toBe(1);
    expect(typeof seeds[0], "drawn, not pinned — no seed was configured anywhere above").toBe(
      "number",
    );
  });

  it("rotates the seed when the SAME bundle is built again (a rebuild, not a sibling), proving the shared value is one build's session rather than a fixed number", async () => {
    await run({ bundle: fakeBundle({ displayName: "app.[hash].js", publicId: "aaa" }) });
    await run({ bundle: fakeBundle({ displayName: "app.[hash].js", publicId: "aaa" }) });

    const [first, second] = seedsSoFar();
    expect(second).not.toBe(first);
  });

  it("draws an unrelated seed for a DIFFERENT project root", async () => {
    await run({ bundle: fakeBundle({ publicId: "aaa" }) });
    const first = seedsSoFar()[0];

    const otherRoot = mkdtempSync(join(tmpdir(), "afterpack-parcel-other-"));
    try {
      await handlers.optimize({
        bundle: fakeBundle({ publicId: "bbb" }),
        contents: "export const a = 1;",
        map: null,
        config: pluginConfig(),
        logger: { warn: () => {}, info: () => {} },
        options: { projectRoot: otherRoot, mode: "production", env: {}, inputFS: {} },
        getSourceMapReference: async () => null,
      });
      expect(seedsSoFar()[1]).not.toBe(first);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it("pins every bundle when the user set AFTERPACK_SEED (the cross-worker channel)", async () => {
    const env = { AFTERPACK_SEED: "5150" };
    await run({ bundle: fakeBundle({ publicId: "aaa" }), env });
    await run({ bundle: fakeBundle({ publicId: "bbb" }), env });

    expect(engineCalls.map((c) => c.config.seed)).toEqual([5150, 5150]);
  });
});

describe("per-bundle Protection Map", () => {
  it("names the map from the bundle so two bundles do not overwrite each other", async () => {
    __setProcessResult(() => ({
      code: "OBF",
      sourceMap: null,
      protectionMap: { schemaVersion: 4, files: [] },
    }));
    const opts: AfterpackConfig = { protectionMap: { enabled: true } };

    await run({
      bundle: fakeBundle({ displayName: "app.[hash].js", publicId: "aaa" }),
      config: opts,
    });
    await run({
      bundle: fakeBundle({ displayName: "lazy.[hash].js", publicId: "bbb" }),
      config: opts,
    });

    expect(readdirSync(join(root, ".afterpack")).sort()).toEqual([
      "app.js.aaa.protectionMap.html",
      "lazy.js.bbb.protectionMap.html",
    ]);
  });
});

describe("source map emission", () => {
  it("drops the map in production, where it would lead back to original source", async () => {
    __setProcessResult(() => ({ code: "OBF", sourceMap: JSON.stringify({ version: 3 }) }));

    const result = await run({ mode: "production", env: { NODE_ENV: "production" } });

    expect(result.map).toBeNull();
    expect(result.contents).not.toContain("sourceMappingURL");
  });

  it("returns a SourceMap and appends Parcel's own reference outside production", async () => {
    const map = {
      version: 3,
      sources: ["a.js"],
      names: [],
      mappings: "AAAA",
      sourcesContent: ["x"],
    };
    __setProcessResult(() => ({ code: "OBF", sourceMap: JSON.stringify(map) }));

    const result = await run({ mode: "development", sourceMapReference: "app.abc.js.map" });

    expect(result.map).not.toBeNull();
    expect(result.contents).toContain("//# sourceMappingURL=app.abc.js.map");
  });
});

describe("directives", () => {
  const NON_ENTRY_CONTENTS =
    "(() => {\n/* @afterpack hardened */ function $68aafebd09799cb3$export$f30560b38e7a0db1(x) {\n    const y = x + 1;\n    const z = y * 2;\n    return z + $68aafebd09799cb3$var$doMore(y);\n}\n/* @afterpack end */ function $68aafebd09799cb3$var$doMore(v) {\n    let total = 0;\n    for(let i = 0; i < v; i++)total += i * i;\n    return total;\n}\nfunction $68aafebd09799cb3$export$89411e8292800ac6(a, b) {\n    return a - b;\n}\n\n\nfunction $126253d09ea9a1dc$var$main() {\n    const r1 = (0, $68aafebd09799cb3$export$f30560b38e7a0db1)(5);\n    const r2 = (0, $68aafebd09799cb3$export$89411e8292800ac6)(10, 3);\n    console.log(r1, r2);\n}\n$126253d09ea9a1dc$var$main();\n\n})();\n//# sourceMappingURL=entry.js.map\n";
  const NON_ENTRY_MAP = {
    mappings:
      ";ACAA,uBAAuB,GAChB,SAAS,0CAAU,CAAC;IACzB,MAAM,IAAI,IAAI;IACd,MAAM,IAAI,IAAI;IACd,OAAO,IAAI,6BAAO;AACpB;AACA,kBAAkB,GAElB,SAAS,6BAAO,CAAC;IACf,IAAI,QAAQ;IACZ,IAAK,IAAI,IAAI,GAAG,IAAI,GAAG,IACrB,SAAS,IAAI;IAEf,OAAO;AACT;AAEO,SAAS,0CAAU,CAAC,EAAE,CAAC;IAC5B,OAAO,IAAI;AACb;;;ADhBA,SAAS;IACP,MAAM,KAAK,CAAA,GAAA,yCAAQ,EAAE;IACrB,MAAM,KAAK,CAAA,GAAA,yCAAQ,EAAE,IAAI;IACzB,QAAQ,GAAG,CAAC,IAAI;AAClB;AAEA",
    sources: ["entry.js", "helper.js"],
    sourcesContent: [
      'import { helperOne, helperTwo } from "./helper.js";\n\nfunction main() {\n  const r1 = helperOne(5);\n  const r2 = helperTwo(10, 3);\n  console.log(r1, r2);\n}\n\nmain();\n',
      "/* @afterpack preset=hard */\nexport function helperOne(x) {\n  const y = x + 1;\n  const z = y * 2;\n  return z + doMore(y);\n}\n/* @afterpack end */\n\nfunction doMore(v) {\n  let total = 0;\n  for (let i = 0; i < v; i++) {\n    total += i * i;\n  }\n  return total;\n}\n\nexport function helperTwo(a, b) {\n  return a - b;\n}\n",
    ],
    names: [],
    version: 3,
    file: "entry.js.map",
  };

  it("round-trips a directive placed in a NON-entry module, reading it from sourcesContent since the generated bytes carry no directive marker", async () => {
    await run({
      contents: NON_ENTRY_CONTENTS,
      map: fakeMap(NON_ENTRY_MAP),
      config: { directives: true },
    });

    expect(engineCalls[0].regions).toBeDefined();
    const regions = engineCalls[0].regions as Array<{
      start: number;
      end: number;
    }>;
    expect(regions.length).toBeGreaterThan(0);
    const coveredText = regions.map((r) => NON_ENTRY_CONTENTS.slice(r.start, r.end)).join("");
    expect(coveredText).toContain("$68aafebd09799cb3$export$f30560b38e7a0db1");
    expect(coveredText).not.toContain("$126253d09ea9a1dc$var$main");
  });

  it("warns loudly when the entry module's directive has no live segment, not misreporting it as tree-shaken", async () => {
    const map = {
      version: 3,
      sources: ["<anon>", "entry.js"],
      sourcesContent: [
        '/* @afterpack preset=hard */\nfunction licenseCheck(k){return k==="OK";}\n/* @afterpack end */\n',
        '/* @afterpack preset=hard */\nfunction licenseCheck(k){return k==="OK";}\n/* @afterpack end */\n',
      ],
      mappings: "",
      names: [],
    };

    await run({ contents: "(()=>{})();", map: fakeMap(map), config: { directives: true } });

    const userVisibleWarnings = warnings.map((w) => w.replace(/\\(.)/g, "$1"));
    expect(engineCalls[0].regions).toBeUndefined();
    expect(userVisibleWarnings.some((w) => w.includes("DIAG_DIRECTIVE_SOURCE_UNRESOLVED"))).toBe(
      true,
    );
    expect(userVisibleWarnings.some((w) => w.includes("entry.js"))).toBe(true);
    expect(warnings.some((w) => w.includes("\\`entry.js\\`"))).toBe(true);
    expect(userVisibleWarnings.join("\n")).not.toContain("tree-shaken");
  });
});

describe("loadConfig", () => {
  it("reads afterpack.json from the project root, and nothing else", async () => {
    const seen: { searchPath?: string; fileNames?: string[] } = {};
    const config = {
      getConfigFrom: async (searchPath: string, fileNames: string[]) => {
        Object.assign(seen, { searchPath, fileNames });
        return { contents: { seed: 7, paths: { exclude: ["vendor/**"] } } };
      },
    };

    const loaded = (await handlers.loadConfig({
      config,
      options: { projectRoot: root, env: {} },
    })) as {
      options: { seed?: number };
      engineConfig: unknown;
    };

    expect(loaded.options.seed).toBe(7);
    expect(loaded.engineConfig).toEqual({ seed: 7, paths: { exclude: ["vendor/**"] } });
    expect(seen.searchPath).toBe(join(root, "index"));
    expect(seen.fileNames).toEqual(["afterpack.json"]);
  });

  it("FAILS the build on an unknown key rather than discarding it", async () => {
    const config = { getConfigFrom: async () => ({ contents: { hardened: true } }) };
    await expect(
      handlers.loadConfig({ config, options: { projectRoot: root, env: {} } }),
    ).rejects.toThrow(/unknown configuration key `hardened`/);
  });

  it("falls back to an empty config when no file exists", async () => {
    const config = { getConfigFrom: async () => null };
    const loaded = (await handlers.loadConfig({
      config,
      options: { projectRoot: root, env: {} },
    })) as { engineConfig: unknown };
    expect(loaded.engineConfig).toEqual({});
  });

  it("lets AFTERPACK_* outrank the file, and refuses a malformed value there", async () => {
    const config = { getConfigFrom: async () => ({ contents: { preset: "light" } }) };
    const loaded = (await handlers.loadConfig({
      config,
      options: { projectRoot: root, env: { AFTERPACK_preset: "hard" } },
    })) as { engineConfig: { preset?: string } };
    expect(loaded.engineConfig.preset).toBe("hard");

    await expect(
      handlers.loadConfig({
        config,
        options: { projectRoot: root, env: { AFTERPACK_preset: "nope" } },
      }),
    ).rejects.toThrow(/minify, light, medium, hard, extreme/);
  });
});

describe("the shared gitignore guard still runs on the in-memory path", () => {
  it("writes the artifact globs into the project root", async () => {
    await run();
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(".afterpack/");
  });
});
