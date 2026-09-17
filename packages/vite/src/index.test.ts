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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __reset,
  __setProcessResult,
  type EngineCall,
  engineCalls,
} from "../../../test/core-fake.js";
import { resetBuildSessions } from "../../integration-utils/src/seed.js";
import { type AfterpackViteOptions, afterpackVite } from "./index.js";

let root: string;
let outDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "afterpack-vite-test-"));
  outDir = join(root, "dist");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(root, ".gitignore"), "");
  resetBuildSessions();
  __reset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

interface BundleEntry {
  type: string;
  fileName: string;
  code?: string;
  source?: string;
  map?: { toString(): string } | null;
  sourcemapFileName?: string | null;
  modules?: Record<string, unknown>;
}

function chunk(fileName: string, code: string, extra: Partial<BundleEntry> = {}): BundleEntry {
  return { type: "chunk", fileName, code, modules: {}, ...extra };
}

function bundleOf(...entries: BundleEntry[]): Record<string, BundleEntry> {
  return Object.fromEntries(entries.map((e) => [e.fileName, e]));
}

async function runPlugin(
  options: AfterpackViteOptions,
  bundle: Record<string, BundleEntry> = bundleOf(chunk("a.js", "export const a = 1;")),
): Promise<Record<string, BundleEntry>> {
  const plugin = afterpackVite(options);
  // biome-ignore lint/suspicious/noExplicitAny: exercising Vite hooks directly in a test.
  const p = plugin as any;
  p.configResolved({ root, build: { outDir } });
  await p.generateBundle.handler.call({}, { dir: outDir }, bundle);
  return bundle;
}

function sharedConfig(): Record<string, unknown> {
  if (engineCalls.length === 0) throw new Error("no engine calls recorded");
  return JSON.parse(engineCalls[0].configJson);
}

function callForInput(source: string): EngineCall {
  const call = engineCalls.find((c) => c.input === source);
  if (!call) throw new Error(`no engine call for the given source`);
  return call;
}

describe("afterpackVite hook placement", () => {
  it("runs transform with enforce:'pre', before any code-regenerating plugin", () => {
    expect(afterpackVite({}).enforce).toBe("pre");
  });

  it("runs generateBundle with order:'post', after every other plugin's generateBundle", () => {
    const hook = afterpackVite({}).generateBundle as { order?: string };
    expect(hook.order).toBe("post");
  });
});

describe("afterpackVite generateBundle (dev policy)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.stubEnv("CI", "");
    vi.stubEnv("NODE_ENV", "development");
    __setProcessResult((input) => ({
      code: `OBF:${input}`,
      sourceMap: '{"version":3,"sources":["a.ts"]}',
      protectionMap: {
        file: { path: "chunk", bytes: input.length },
        source: input,
        regions: [],
        spotlights: [],
        aggregate: { classSummary: {} },
      },
      diagnostics: [],
    }));
  });

  it("obfuscates every chunk in the bundle and writes the combined protectionMap.html", async () => {
    const bundle = await runPlugin(
      { protectionMap: true, sourceMap: { emitUrl: true } },
      bundleOf(chunk("a.js", "export const a = 1;"), chunk("b.mjs", "export const b = 2;")),
    );

    expect(bundle["a.js"].code).toContain("OBF:export const a = 1;");
    expect(bundle["b.mjs"].code).toContain("OBF:export const b = 2;");
    expect(readdirSync(outDir), "nothing reaches the output directory from this hook").toEqual([]);
    const pm = readFileSync(join(root, ".afterpack", "protectionMap.html"), "utf8");
    expect(pm).not.toMatch(/https?:\/\//i);
    expect((sharedConfig().protectionMap as { enabled: boolean }).enabled).toBe(true);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain("*.protectionMap.html");
  });

  it("passes Vite's live chunk map on the FileInput and replaces its bundle entry", async () => {
    const upstream = '{"version":3,"sources":["app.ts"],"mappings":"AAAA"}';
    const src = "console.log(1);\n//# sourceMappingURL=app.js.map\n";
    const bundle = await runPlugin(
      { protectionMap: true, sourceMap: { emitUrl: true } },
      bundleOf(
        chunk("app.js", src, {
          map: { toString: () => upstream },
          sourcemapFileName: "app.js.map",
        }),
        { type: "asset", fileName: "app.js.map", source: upstream },
      ),
    );

    expect(callForInput(src).inputSourceMap).toBe(upstream);
    expect(bundle["app.js.map"].source).toContain('"sources":["a.ts"]');
    expect(bundle["app.js"].code).toMatch(/\/\/# sourceMappingURL=app\.js\.map\n$/);
    expect(
      (sharedConfig().sourceMap as { enabled?: boolean }).enabled,
      "source-map emission stays per-file, never baked into the shared config",
    ).toBeUndefined();
  });

  it("capture transform never mutates code", () => {
    const plugin = afterpackVite({});
    // biome-ignore lint/suspicious/noExplicitAny: exercising Vite hooks directly in a test.
    expect((plugin.transform as any)("const x = 1;", "id.js")).toBeNull();
  });
});

describe("afterpackVite generateBundle (production policy)", () => {
  const prevNodeEnv = process.env.NODE_ENV;
  beforeEach(() => {
    process.env.NODE_ENV = "production";
    __setProcessResult((input) => ({
      code: `OBF:${input}`,
      sourceMap: '{"version":3}',
      protectionMap: {
        file: { path: "x" },
        source: input,
        regions: [],
        spotlights: [],
        aggregate: {},
      },
      diagnostics: [],
    }));
  });
  afterEach(() => {
    process.env.NODE_ENV = prevNodeEnv;
  });

  it("drops the map entry (prod maps-off), the URL comment, and the Protection Map", async () => {
    const upstream = '{"version":3,"sources":["a.ts"],"mappings":"AAAA"}';
    const bundle = await runPlugin(
      { protectionMap: false },
      bundleOf(
        chunk("a.js", "export const a = 1;\n//# sourceMappingURL=a.js.map\n", {
          map: { toString: () => upstream },
          sourcemapFileName: "a.js.map",
        }),
        { type: "asset", fileName: "a.js.map", source: upstream },
      ),
    );

    expect(bundle["a.js.map"]).toBeUndefined();
    expect(bundle["a.js"].code).not.toContain("sourceMappingURL");
    expect(existsSync(join(outDir, "protectionMap.html"))).toBe(false);
    expect((sharedConfig().protectionMap as { enabled: boolean }).enabled).toBe(false);
  });
});

describe("afterpackVite preset bundle vs numeric complexity", () => {
  beforeEach(() => {
    __setProcessResult((input) => ({
      code: `OBF:${input}`,
      sourceMap: null,
      protectionMap: null,
      diagnostics: [],
    }));
  });

  it("zero-config ships complexity 2 with no preset and leaves strings.encode to the engine", async () => {
    await runPlugin({});
    const cfg = sharedConfig();
    expect(cfg.preset).toBeUndefined();
    expect(cfg.complexity).toBe(2);
    expect(cfg.strings).toBeUndefined();
  });

  it('preset:"minify" ships the preset, not a flattened complexity, and leaves strings.encode to the engine', async () => {
    await runPlugin({ preset: "minify" });
    const cfg = sharedConfig();
    expect(cfg.preset).toBe("minify");
    expect(cfg.complexity).toBeUndefined();
    expect(cfg.strings).toBeUndefined();
  });

  it("preset + complexity sends both, so the engine keeps the bundle's limits", async () => {
    await runPlugin({ preset: "hard", complexity: 40 });
    const cfg = sharedConfig();
    expect(cfg.preset).toBe("hard");
    expect(cfg.complexity).toBe(40);
  });
});

describe("afterpackVite per-region overrides", () => {
  beforeEach(() => {
    __setProcessResult((input) => ({
      code: `OBF:${input}`,
      sourceMap: null,
      protectionMap: null,
      diagnostics: [],
    }));
  });

  it("forwards a hand-authored regions array into the shared engine config", async () => {
    const regions = [{ start: 0, end: 12, floor: false }];
    await runPlugin({ regions });
    expect(sharedConfig().regions).toEqual(regions);
  });

  it("omits regions from the config when none are supplied (byte-identical default)", async () => {
    await runPlugin({});
    expect("regions" in sharedConfig()).toBe(false);
  });
});

describe("afterpackVite directive capture (single-file, un-bundled)", () => {
  const DIRECTIVE = 'const s = /* @afterpack strings.encode=off */ "KEEP";\n';

  beforeEach(() => {
    __setProcessResult((input) => ({
      code: `OBF:${input}`,
      sourceMap: null,
      protectionMap: null,
      diagnostics: [],
    }));
  });

  it("captures a single-file source directive into the shared engine config", async () => {
    await runPlugin({}, bundleOf(chunk("only.js", DIRECTIVE)));
    const regions = sharedConfig().regions as Array<{ floor?: boolean }>;
    expect(regions).toHaveLength(1);
    expect(regions[0].floor).toBe(false);
  });

  it("merges captured regions AFTER hand-authored ones (single file)", async () => {
    const hand = [{ start: 0, end: 4, target: 0 }];
    await runPlugin({ regions: hand }, bundleOf(chunk("only.js", DIRECTIVE)));
    const regions = sharedConfig().regions as Array<Record<string, unknown>>;
    expect(regions).toHaveLength(2);
    expect(regions[0]).toEqual(hand[0]);
    expect(regions[1].floor).toBe(false);
  });

  it("keeps a multi-file build's directives out of the shared regions config", async () => {
    await runPlugin(
      {},
      bundleOf(
        chunk("a.js", "const a = /* @afterpack skip */ 1;\n"),
        chunk("b.js", "const b = 2;\n"),
      ),
    );
    expect("regions" in sharedConfig()).toBe(false);
  });

  it("directives:false disables source capture", async () => {
    await runPlugin({ directives: false }, bundleOf(chunk("only.js", DIRECTIVE)));
    expect("regions" in sharedConfig()).toBe(false);
  });
});

describe("afterpackVite fail-closed + autorun", () => {
  it("throws (failing the build) and leaves the bundle's own bytes in place", async () => {
    __setProcessResult(() => ({
      code: "",
      sourceMap: null,
      protectionMap: null,
      diagnostics: [{ severity: "error", message: "reflection not acknowledged", code: "DIAG_X" }],
    }));
    const bundle = bundleOf(chunk("a.js", "eval('x');"));
    await expect(runPlugin({}, bundle)).rejects.toThrow(/failed to obfuscate/);
    expect(bundle["a.js"].code).toBe("eval('x');");
    expect(readdirSync(outDir)).toEqual([]);
  });

  it("does nothing when autorun is disabled", async () => {
    const bundle = await runPlugin({ build: { autorun: false } });
    expect(bundle["a.js"].code).toBe("export const a = 1;");
    expect(engineCalls).toHaveLength(0);
  });
});

describe("afterpackVite writeBundle (protection receipt)", () => {
  beforeEach(() => {
    __setProcessResult((input) => ({ code: `OBF:${input}`, sourceMap: null, protectionMap: null }));
  });

  it("writes .afterpack-protection.json in writeBundle for the files vite actually wrote", async () => {
    const plugin = afterpackVite({});
    // biome-ignore lint/suspicious/noExplicitAny: exercising Vite hooks directly in a test.
    const p = plugin as any;
    p.configResolved({ root, build: { outDir } });
    const bundle = bundleOf(chunk("a.js", "export const a = 1;"));
    await p.generateBundle.handler.call({}, { dir: outDir }, bundle);
    const emitted = bundle["a.js"].code;
    if (emitted === undefined) throw new Error("the pass left the chunk with no code");
    writeFileSync(join(outDir, "a.js"), emitted);
    await p.writeBundle();

    const receiptPath = join(outDir, ".afterpack-protection.json");
    expect(existsSync(receiptPath)).toBe(true);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    expect(receipt.files.map((f: { path: string }) => f.path)).toEqual(["a.js"]);
  });

  it("still writes the receipt on diagnostics.level=none, but says nothing about it", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m: string) => {
      logged.push(m);
    });
    try {
      const plugin = afterpackVite({ diagnostics: { level: "none" } });
      // biome-ignore lint/suspicious/noExplicitAny: exercising Vite hooks directly in a test.
      const p = plugin as any;
      p.configResolved({ root, build: { outDir } });
      const bundle = bundleOf(chunk("a.js", "export const a = 1;"));
      await p.generateBundle.handler.call({}, { dir: outDir }, bundle);
      const emitted = bundle["a.js"].code;
      if (emitted === undefined) throw new Error("the pass left the chunk with no code");
      writeFileSync(join(outDir, "a.js"), emitted);
      await p.writeBundle();

      expect(existsSync(join(outDir, ".afterpack-protection.json"))).toBe(true);
      expect(logged.join("\n")).not.toContain("protection receipt");
    } finally {
      spy.mockRestore();
    }
  });

  it("does not write a receipt for a file vite never flushed to disk", async () => {
    const plugin = afterpackVite({});
    // biome-ignore lint/suspicious/noExplicitAny: exercising Vite hooks directly in a test.
    const p = plugin as any;
    p.configResolved({ root, build: { outDir } });
    const bundle = bundleOf(chunk("a.js", "export const a = 1;"));
    await p.generateBundle.handler.call({}, { dir: outDir }, bundle);
    await p.writeBundle();

    expect(existsSync(join(outDir, ".afterpack-protection.json"))).toBe(false);
  });
});

describe("afterpackVite config() sourcemap auto-enable", () => {
  function runConfig(
    options: AfterpackViteOptions,
    userConfig: Record<string, unknown>,
    // biome-ignore lint/suspicious/noExplicitAny: exercising the Vite hook directly.
  ): any {
    // biome-ignore lint/suspicious/noExplicitAny: exercising the Vite hook directly.
    return (afterpackVite(options).config as any)(userConfig);
  }

  it("auto-enables build.sourcemap when protectionMap:true and the user set none", () => {
    expect(runConfig({ protectionMap: true }, {})).toEqual({ build: { sourcemap: true } });
  });

  it("respects an explicit build.sourcemap:false (never overrides it)", () => {
    expect(runConfig({ protectionMap: true }, { build: { sourcemap: false } })).toBeUndefined();
  });

  it("leaves an already-true build.sourcemap alone", () => {
    expect(runConfig({ protectionMap: true }, { build: { sourcemap: true } })).toBeUndefined();
  });

  it("does nothing unless protectionMap was explicitly requested", () => {
    expect(runConfig({}, {})).toBeUndefined();
    expect(runConfig({ protectionMap: false }, {})).toBeUndefined();
  });
});

describe("afterpackVite leg (multi-config builds)", () => {
  beforeEach(() => {
    __setProcessResult((input) => ({ code: `OBF:${input}`, diagnostics: [] }));
  });

  it("obfuscates only the bundle THIS leg emitted, even sharing one outDir", async () => {
    const mine = bundleOf(chunk("mine.js", "const mine = 1;"));
    await runPlugin({ leg: "main" }, mine);
    expect(mine["mine.js"].code).toBe("OBF:const mine = 1;");
    expect(engineCalls.map((c) => c.input)).toEqual(["const mine = 1;"]);
  });

  it("nests each leg's combined Protection Map under .afterpack/<leg>/", async () => {
    __setProcessResult((input) => ({
      code: `OBF:${input}`,
      protectionMap: {
        file: { path: "chunk", bytes: input.length },
        source: input,
        regions: [],
        spotlights: [],
        aggregate: { classSummary: {} },
      },
      diagnostics: [],
    }));
    await runPlugin({ leg: "preload", protectionMap: true });
    expect(existsSync(join(root, ".afterpack", "preload", "protectionMap.html"))).toBe(true);
    expect(existsSync(join(root, ".afterpack", "protectionMap.html"))).toBe(false);
  });

  it("two legs sharing ONE outDir each obfuscate their own bundle, with ONE seed", async () => {
    await runPlugin({ leg: "main" }, bundleOf(chunk("main.js", "const m = 1;")));
    await runPlugin({ leg: "preload" }, bundleOf(chunk("preload.js", "const p = 1;")));
    expect(engineCalls).toHaveLength(2);
    const seeds = engineCalls.map((c) => JSON.parse(c.configJson).seed);
    expect(seeds[0]).toBe(seeds[1]);
    expect(engineCalls.map((c) => c.input)).toEqual(["const m = 1;", "const p = 1;"]);
  });

  it("forgets nothing across builds: one instance, two bundles, each its own", async () => {
    const plugin = afterpackVite({ leg: "shared" });
    // biome-ignore lint/suspicious/noExplicitAny: exercising Vite hooks directly in a test.
    const p = plugin as any;
    p.configResolved({ root, build: { outDir } });
    await p.generateBundle.handler.call(
      {},
      { dir: outDir },
      bundleOf(chunk("first.js", "const a = 1;")),
    );
    await p.generateBundle.handler.call(
      {},
      { dir: outDir },
      bundleOf(chunk("second.js", "const b = 1;")),
    );
    expect(engineCalls).toHaveLength(2);
    expect(engineCalls[1].input).toBe("const b = 1;");
  });
});

describe("afterpack.json", () => {
  it("reaches the engine when the plugin was given no options at all", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(root);
    writeFileSync(
      join(root, "afterpack.json"),
      JSON.stringify({ preset: "hard", identifiers: { rename: false } }),
    );
    __setProcessResult((input) => ({ code: `OBF:${input}`, diagnostics: [] }));

    await runPlugin({});

    expect(sharedConfig().preset).toBe("hard");
    expect(sharedConfig().identifiers).toEqual({ rename: false });
  });

  it("is outranked by the plugin options object", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(root);
    writeFileSync(join(root, "afterpack.json"), JSON.stringify({ preset: "hard" }));
    __setProcessResult((input) => ({ code: `OBF:${input}`, diagnostics: [] }));

    await runPlugin({ preset: "medium" });

    expect(sharedConfig().preset).toBe("medium");
  });

  it("fails the build on an unknown key instead of silently dropping it", () => {
    vi.spyOn(process, "cwd").mockReturnValue(root);
    writeFileSync(join(root, "afterpack.json"), JSON.stringify({ level: "medium" }));
    expect(() => afterpackVite({})).toThrow(/unknown configuration key `level`/);
  });

  it("fails the build on an unknown PLUGIN option instead of silently dropping it", () => {
    vi.spyOn(process, "cwd").mockReturnValue(root);
    // biome-ignore lint/suspicious/noExplicitAny: the point of the test is an off-schema option.
    expect(() => afterpackVite({ level: "medium" } as any)).toThrow(/unknown configuration key/);
  });

  it("refuses `paths.include`, which this plugin has no disk walk to apply", () => {
    vi.spyOn(process, "cwd").mockReturnValue(root);
    writeFileSync(
      join(root, "afterpack.json"),
      JSON.stringify({ paths: { include: ["**/node_modules/**"] } }),
    );
    expect(() => afterpackVite({})).toThrow(/`paths.include` is not supported here/);
  });
});
