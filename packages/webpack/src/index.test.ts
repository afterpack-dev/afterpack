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
import { PROTECTION_RECEIPT_FILE } from "@afterpack/integration-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __reset, __setProcessResult, engineCalls } from "../../../test/core-fake.js";
import { AfterpackWebpackPlugin } from "./index.js";

let root: string;
let outDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "afterpack-webpack-test-"));
  outDir = join(root, "dist");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(root, ".gitignore"), "");
  __reset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  __setProcessResult((input) => ({ code: `OBF:${input}`, sourceMap: null, protectionMap: null }));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

interface FakeAsset {
  content: string;
  info: Record<string, unknown>;
}

interface Fixture {
  assets: Map<string, FakeAsset>;
  claimed: string[];
}

function applyPlugin(
  plugin: AfterpackWebpackPlugin,
  compilerOptions: Record<string, unknown> = {},
): (fixture: Fixture) => Promise<Map<string, FakeAsset>> {
  let tap: (() => Promise<void>) | undefined;
  let onCompilation: ((compilation: unknown) => void) | undefined;
  let afterEmitTap: ((compilation: unknown) => Promise<void>) | undefined;
  const compiler = {
    outputPath: outDir,
    options: { context: root, devtool: false, ...compilerOptions },
    webpack: {
      Compilation: { PROCESS_ASSETS_STAGE_REPORT: 5000 },
      sources: {
        RawSource: class {
          constructor(private readonly value: string) {}
          source(): string {
            return this.value;
          }
        },
      },
      NormalModule: {
        getCompilationHooks: () => ({ beforeLoaders: { tap: () => {} } }),
      },
    },
    hooks: {
      thisCompilation: { tap: () => {} },
      compilation: {
        tap: (_name: string, fn: (compilation: unknown) => void) => {
          onCompilation = fn;
        },
      },
      afterEmit: {
        tapPromise: (_name: string, fn: (compilation: unknown) => Promise<void>) => {
          afterEmitTap = fn;
        },
      },
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: exercising the webpack apply() with a fake compiler.
  plugin.apply(compiler as any);

  return async (fixture: Fixture) => {
    const { assets, claimed } = fixture;
    const compilation = {
      chunks: [{ files: new Set(claimed) }],
      hooks: {
        processAssets: {
          tapPromise: (_options: unknown, fn: () => Promise<void>) => {
            tap = fn;
          },
        },
      },
      getAsset: (name: string) => {
        const asset = assets.get(name);
        return asset
          ? { name, info: asset.info, source: { source: () => asset.content } }
          : undefined;
      },
      updateAsset: (name: string, source: { source(): string }) => {
        const existing = assets.get(name);
        assets.set(name, { content: source.source(), info: existing?.info ?? {} });
      },
      emitAsset: (name: string, source: { source(): string }) => {
        assets.set(name, { content: source.source(), info: {} });
      },
      deleteAsset: (name: string) => {
        assets.delete(name);
      },
    };
    if (!onCompilation) throw new Error("compilation hook was not tapped");
    onCompilation(compilation);
    if (!tap) throw new Error("processAssets hook was not registered");
    await tap();
    if (afterEmitTap) await afterEmitTap(compilation);
    return assets;
  };
}

function fixture(entries: Record<string, string>, claimed: string[]): Fixture {
  const assets = new Map<string, FakeAsset>();
  for (const [name, content] of Object.entries(entries)) assets.set(name, { content, info: {} });
  return { assets, claimed };
}

describe("AfterpackWebpackPlugin processAssets", () => {
  it("rewrites chunk-claimed JS in memory, skips non-JS + hot-update, writes NO backup", async () => {
    const invoke = applyPlugin(new AfterpackWebpackPlugin({}));
    const assets = await invoke(
      fixture(
        {
          "main.js": "export const a = 1;",
          "vendor.mjs": "export const b = 2;",
          "styles.css": ".x{}",
          "main.hot-update.js": "hmr();",
        },
        ["main.js", "vendor.mjs", "styles.css", "main.hot-update.js"],
      ),
    );

    expect(assets.get("main.js")?.content).toBe("OBF:export const a = 1;");
    expect(assets.get("vendor.mjs")?.content).toBe("OBF:export const b = 2;");
    expect(assets.get("styles.css")?.content).toBe(".x{}");
    expect(assets.get("main.hot-update.js")?.content).toBe("hmr();");
    expect(
      readdirSync(outDir).some((f) => /\.backup\./.test(f)),
      "nothing is written beside the output",
    ).toBe(false);
    expect(engineCalls.map((c) => c.input).sort()).toEqual([
      "export const a = 1;",
      "export const b = 2;",
    ]);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain("*.protectionMap.html");
  });

  it("leaves an asset no chunk claims alone (a manifest another plugin emitted)", async () => {
    const invoke = applyPlugin(new AfterpackWebpackPlugin({}));
    const assets = await invoke(
      fixture({ "main.js": "export const a = 1;", "server/manifest.js": "self.__M=[];" }, [
        "main.js",
      ]),
    );
    expect(assets.get("server/manifest.js")?.content).toBe("self.__M=[];");
    expect(engineCalls.map((c) => c.input)).toEqual(["export const a = 1;"]);
  });

  it("never lets the cleartext bundle reach disk: the output dir stays empty", async () => {
    const invoke = applyPlugin(new AfterpackWebpackPlugin({}));
    await invoke(fixture({ "main.js": "export const a = 1;" }, ["main.js"]));
    expect(readdirSync(outDir)).toEqual([]);
  });

  it("forwards a hand-authored regions array into the shared engine config", async () => {
    const regions = [{ start: 0, end: 12, floor: false }];
    const invoke = applyPlugin(new AfterpackWebpackPlugin({ regions }));
    await invoke(fixture({ "main.js": "export const a = 1;" }, ["main.js"]));
    expect(JSON.parse(engineCalls[0].configJson).regions).toEqual(regions);
  });

  it("does nothing when build.autorun is disabled via the option", async () => {
    const invoke = applyPlugin(new AfterpackWebpackPlugin({ build: { autorun: false } }));
    const assets = await invoke(fixture({ "main.js": "export const a = 1;" }, ["main.js"]));
    expect(assets.get("main.js")?.content).toBe("export const a = 1;");
    expect(engineCalls).toHaveLength(0);
  });

  it("does nothing when AFTERPACK_build_autorun=false is set", async () => {
    const prev = process.env.AFTERPACK_build_autorun;
    process.env.AFTERPACK_build_autorun = "false";
    try {
      const invoke = applyPlugin(new AfterpackWebpackPlugin({}));
      await invoke(fixture({ "main.js": "export const a = 1;" }, ["main.js"]));
      expect(engineCalls).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.AFTERPACK_build_autorun;
      else process.env.AFTERPACK_build_autorun = prev;
    }
  });

  it("fails the build (the hook rejects) when the engine reports an error", async () => {
    __setProcessResult(() => ({
      code: "",
      sourceMap: null,
      protectionMap: null,
      diagnostics: [{ severity: "error", message: "boom", code: "DIAG_X" }],
    }));
    const invoke = applyPlugin(new AfterpackWebpackPlugin({}));
    await expect(invoke(fixture({ "main.js": "eval('x');" }, ["main.js"]))).rejects.toThrow(
      /failed to obfuscate/,
    );
  });

  it("leaves the cleartext asset in place when it refuses the build, and ships nothing", async () => {
    __setProcessResult(() => ({ code: "", sourceMap: null, protectionMap: null }));
    const invoke = applyPlugin(new AfterpackWebpackPlugin({}));
    const assets = new Map([["main.js", { content: "eval('x');", info: {} }]]);
    await expect(invoke({ assets, claimed: ["main.js"] })).rejects.toThrow();
    expect(assets.get("main.js")?.content).toBe("eval('x');");
    expect(readdirSync(outDir)).toEqual([]);
  });
});

describe("AfterpackWebpackPlugin protection receipt", () => {
  it("writes .afterpack-protection.json in afterEmit for the files webpack actually wrote", async () => {
    writeFileSync(join(outDir, "main.js"), "OBF:export const a = 1;");
    const invoke = applyPlugin(new AfterpackWebpackPlugin({}));
    await invoke(fixture({ "main.js": "export const a = 1;" }, ["main.js"]));

    const receiptPath = join(outDir, PROTECTION_RECEIPT_FILE);
    expect(existsSync(receiptPath)).toBe(true);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    expect(receipt.files.map((f: { path: string }) => f.path)).toEqual(["main.js"]);
  });

  it("does not write a receipt for a file the bundler never flushed to disk", async () => {
    const invoke = applyPlugin(new AfterpackWebpackPlugin({}));
    await invoke(fixture({ "main.js": "export const a = 1;" }, ["main.js"]));

    expect(existsSync(join(outDir, PROTECTION_RECEIPT_FILE))).toBe(false);
  });
});

describe("AfterpackWebpackPlugin source maps", () => {
  const withMap = (): Fixture => {
    const assets = new Map<string, FakeAsset>([
      [
        "main.js",
        {
          content: "export const a = 1;\n//# sourceMappingURL=main.js.map\n",
          info: { related: { sourceMap: "main.js.map" } },
        },
      ],
      ["main.js.map", { content: '{"version":3,"sources":["a.js"],"mappings":""}', info: {} }],
    ]);
    return { assets, claimed: ["main.js"] };
  };

  it("reads the map from the compilation and replaces it with the map the obfuscation pass returns", async () => {
    __setProcessResult((input) => ({
      code: `OBF:${input}`,
      sourceMap: '{"version":3,"sources":["a.js"],"mappings":"AAAA"}',
      protectionMap: null,
    }));
    const invoke = applyPlugin(
      new AfterpackWebpackPlugin({ sourceMap: { enabled: true, emitUrl: true } }),
    );
    const assets = await invoke(withMap());
    expect(engineCalls[0].inputSourceMap).toContain('"sources":["a.js"]');
    expect(assets.get("main.js.map")?.content).toContain('"mappings":"AAAA"');
    expect(assets.get("main.js")?.content).toMatch(/\/\/# sourceMappingURL=main\.js\.map\n$/);
  });

  it("deletes the bundler's own map when policy ships none", async () => {
    const invoke = applyPlugin(
      new AfterpackWebpackPlugin({ sourceMap: false, production: true, protectionMap: false }),
    );
    const assets = await invoke(withMap());
    expect(assets.has("main.js.map")).toBe(false);
    expect(assets.get("main.js")?.content).not.toContain("sourceMappingURL");
  });
});

describe("AfterpackWebpackPlugin afterpack.json", () => {
  it("reaches the engine when the plugin was given no options at all", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(root);
    writeFileSync(join(root, "afterpack.json"), JSON.stringify({ preset: "hard" }));

    await applyPlugin(new AfterpackWebpackPlugin())(
      fixture({ "main.js": "export const a = 1;" }, ["main.js"]),
    );

    expect(JSON.parse(engineCalls[0].configJson).preset).toBe("hard");
  });

  it("is outranked by the plugin options object", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(root);
    writeFileSync(join(root, "afterpack.json"), JSON.stringify({ preset: "hard" }));

    await applyPlugin(new AfterpackWebpackPlugin({ preset: "medium" }))(
      fixture({ "main.js": "export const a = 1;" }, ["main.js"]),
    );

    expect(JSON.parse(engineCalls[0].configJson).preset).toBe("medium");
  });

  it("fails the build on an unknown key instead of silently dropping it", () => {
    vi.spyOn(process, "cwd").mockReturnValue(root);
    writeFileSync(join(root, "afterpack.json"), JSON.stringify({ level: "medium" }));
    expect(() => new AfterpackWebpackPlugin()).toThrow(/unknown configuration key `level`/);
  });

  it("refuses `paths.include`, which this plugin has no disk walk to apply", () => {
    vi.spyOn(process, "cwd").mockReturnValue(root);
    writeFileSync(
      join(root, "afterpack.json"),
      JSON.stringify({ paths: { include: ["**/node_modules/**"] } }),
    );
    expect(() => new AfterpackWebpackPlugin()).toThrow(/`paths.include` is not supported here/);
  });
});
