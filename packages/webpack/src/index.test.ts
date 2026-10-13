import { createHash } from "node:crypto";
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
import { __reset, __setProcessResult, __setVersion, engineCalls } from "../../../test/core-fake.js";
import { AfterpackWebpackPlugin } from "./index.js";

let root: string;
let outDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "afterpack-webpack-test-"));
  writeFileSync(join(root, "package.json"), "{}");
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

interface HashTaps {
  chunkHash?: (chunk: unknown, hash: { update(value: string): void }) => void;
  updateHash?: (content: Buffer[], oldHash: string) => string | undefined;
  noRealContentHashHooks?: boolean;
}

function applyPlugin(
  plugin: AfterpackWebpackPlugin,
  compilerOptions: Record<string, unknown> = {},
  hashTaps: HashTaps = {},
): (fixture: Fixture) => Promise<Map<string, FakeAsset>> {
  let tap: (() => Promise<void>) | undefined;
  let onCompilation: ((compilation: unknown) => void) | undefined;
  let onThisCompilation: ((compilation: unknown) => void) | undefined;
  let make: (() => Promise<void>) | undefined;
  let afterEmitTap: ((compilation: unknown) => Promise<void>) | undefined;
  const compiler = {
    outputPath: outDir,
    options: { context: root, devtool: false, ...compilerOptions },
    webpack: {
      javascript: {
        JavascriptModulesPlugin: {
          getCompilationHooks: () => ({
            chunkHash: {
              tap: (_name: string, fn: NonNullable<HashTaps["chunkHash"]>) => {
                hashTaps.chunkHash = fn;
              },
            },
          }),
        },
      },
      optimize: {
        RealContentHashPlugin: hashTaps.noRealContentHashHooks
          ? {}
          : {
              getCompilationHooks: () => ({
                updateHash: {
                  tap: (_name: string, fn: NonNullable<HashTaps["updateHash"]>) => {
                    hashTaps.updateHash = fn;
                  },
                },
              }),
            },
      },
      util: { createHash: () => createHash("sha256") },
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
      make: {
        tapPromise: (_name: string, fn: () => Promise<void>) => {
          make = fn;
        },
      },
      thisCompilation: {
        tap: (_name: string, fn: (compilation: unknown) => void) => {
          onThisCompilation = fn;
        },
      },
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
      outputOptions: {},
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
      getAssets: () => [...assets.keys()].map((name) => ({ name })),
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
    onThisCompilation?.(compilation);
    onCompilation(compilation);
    await make?.();
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
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("");
  });

  it("writes .afterpack/.gitignore when a Protection Map lands there, and never touches the project's own .gitignore", async () => {
    __setProcessResult((input) => ({
      code: `OBF:${input}`,
      sourceMap: null,
      protectionMap: { schemaVersion: 4, files: [] },
    }));
    const invoke = applyPlugin(new AfterpackWebpackPlugin({ protectionMap: { enabled: true } }));
    await invoke(fixture({ "main.js": "export const a = 1;" }, ["main.js"]));

    expect(readFileSync(join(root, ".afterpack", ".gitignore"), "utf8")).toBe("*\n");
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("");
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
    const regions = [{ start: 0, end: 12, strings: { encode: false } }];
    const invoke = applyPlugin(new AfterpackWebpackPlugin({ regions }));
    await invoke(fixture({ "main.js": "export const a = 1;" }, ["main.js"]));
    expect(engineCalls[0].config.regions).toEqual(regions);
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
  it("writes the receipt to .afterpack/receipts/ in afterEmit for the files webpack actually wrote", async () => {
    writeFileSync(join(outDir, "main.js"), "OBF:export const a = 1;");
    const invoke = applyPlugin(new AfterpackWebpackPlugin({}));
    await invoke(fixture({ "main.js": "export const a = 1;" }, ["main.js"]));

    const receiptPath = join(root, ".afterpack", "receipts", "dist.json");
    expect(existsSync(receiptPath)).toBe(true);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    expect(receipt.files.map((f: { path: string }) => f.path)).toEqual(["main.js"]);
    expect(readdirSync(outDir)).toEqual(["main.js"]);
  });

  it("keeps the receipt with the project when context is a source subdir", async () => {
    const src = join(root, "src");
    mkdirSync(src);
    writeFileSync(join(outDir, "main.js"), "OBF:export const a = 1;");
    const invoke = applyPlugin(new AfterpackWebpackPlugin({}), { context: src });
    await invoke(fixture({ "main.js": "export const a = 1;" }, ["main.js"]));

    expect(existsSync(join(root, ".afterpack", "receipts", "dist.json"))).toBe(true);
    expect(existsSync(join(src, ".afterpack"))).toBe(false);
  });

  it("removes a stale receipt an earlier build left in the output path", async () => {
    writeFileSync(join(outDir, "main.js"), "OBF:export const a = 1;");
    writeFileSync(join(outDir, ".afterpack-protection.json"), "{}");
    const invoke = applyPlugin(new AfterpackWebpackPlugin({}));
    await invoke(fixture({ "main.js": "export const a = 1;" }, ["main.js"]));

    expect(readdirSync(outDir)).toEqual(["main.js"]);
  });

  it("does not write a receipt for a file the bundler never flushed to disk", async () => {
    const invoke = applyPlugin(new AfterpackWebpackPlugin({}));
    await invoke(fixture({ "main.js": "export const a = 1;" }, ["main.js"]));

    expect(existsSync(join(root, ".afterpack", "receipts", "dist.json"))).toBe(false);
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
    expect(engineCalls[0].sourceMap).toContain('"sources":["a.js"]');
    expect(assets.get("main.js.map")?.content).toContain('"mappings":"AAAA"');
    expect(assets.get("main.js")?.content).toMatch(/\/\/# sourceMappingURL=main\.js\.map\n$/);
  });

  it("deletes the bundler's own map when policy ships none", async () => {
    const invoke = applyPlugin(
      new AfterpackWebpackPlugin({
        sourceMap: false,
        build: { mode: "production" },
        protectionMap: false,
      }),
    );
    const assets = await invoke(withMap());
    expect(assets.has("main.js.map")).toBe(false);
    expect(assets.get("main.js")?.content).not.toContain("sourceMappingURL");
  });

  const withCssMap = (): Fixture => {
    const fixture = withMap();
    fixture.assets.set("main.css", {
      content: "a{color:red}\n/*# sourceMappingURL=main.css.map*/",
      info: { related: { sourceMap: "main.css.map" } },
    });
    fixture.assets.set("main.css.map", {
      content: '{"version":3,"sources":["a.css"],"sourcesContent":["a { color: red }"]}',
      info: {},
    });
    return fixture;
  };

  it("deletes the CSS maps and their trailers too when policy ships none", async () => {
    const invoke = applyPlugin(
      new AfterpackWebpackPlugin({
        sourceMap: false,
        build: { mode: "production" },
        protectionMap: false,
      }),
    );
    const assets = await invoke(withCssMap());
    expect([...assets.keys()].sort()).toEqual(["main.css", "main.js"]);
    expect(assets.get("main.css")?.content).toBe("a{color:red}\n");
  });

  it("keeps the CSS maps when policy ships source maps", async () => {
    const invoke = applyPlugin(new AfterpackWebpackPlugin({ sourceMap: { enabled: true } }));
    const assets = await invoke(withCssMap());
    expect(assets.get("main.css.map")?.content).toContain("a { color: red }");
    expect(assets.get("main.css")?.content).toContain("sourceMappingURL=main.css.map");
  });
});

describe("AfterpackWebpackPlugin afterpack.json", () => {
  it("reaches the engine when the plugin was given no options at all", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(root);
    writeFileSync(join(root, "afterpack.json"), JSON.stringify({ preset: "hard" }));

    await applyPlugin(new AfterpackWebpackPlugin())(
      fixture({ "main.js": "export const a = 1;" }, ["main.js"]),
    );

    expect(engineCalls[0].config.preset).toBe("hard");
  });

  it("is outranked by the plugin options object", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(root);
    writeFileSync(join(root, "afterpack.json"), JSON.stringify({ preset: "hard" }));

    await applyPlugin(new AfterpackWebpackPlugin({ preset: "medium" }))(
      fixture({ "main.js": "export const a = 1;" }, ["main.js"]),
    );

    expect(engineCalls[0].config.preset).toBe("medium");
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

describe("AfterpackWebpackPlugin sourceType", () => {
  beforeEach(() => {
    __setVersion("0.2.3");
  });

  it("sends module when output.module is on", async () => {
    const invoke = applyPlugin(new AfterpackWebpackPlugin({}), { output: { module: true } });
    await invoke(fixture({ "main.js": "const a = 1;" }, ["main.js"]));
    expect(engineCalls[0].config.sourceType).toBe("module");
  });

  it("withholds it for classic output", async () => {
    const invoke = applyPlugin(new AfterpackWebpackPlugin({}), { output: { module: false } });
    await invoke(fixture({ "main.js": "const a = 1;" }, ["main.js"]));
    expect(engineCalls[0].config.sourceType).toBeUndefined();
  });
});

describe("AfterpackWebpackPlugin content-hashed names", () => {
  const JS = "main.0123456789abcdef.js";
  const CSS = "main.fedcba9876543210.css";

  async function taps(options: ConstructorParameters<typeof AfterpackWebpackPlugin>[0]) {
    const hashTaps: HashTaps = {};
    const invoke = applyPlugin(new AfterpackWebpackPlugin(options), {}, hashTaps);
    await invoke(fixture({ [JS]: "const a = 1;", [CSS]: "a{}" }, [JS, CSS]));
    return hashTaps;
  }

  function chunkHashUpdates(hashTaps: HashTaps): string[] {
    const updates: string[] = [];
    hashTaps.chunkHash?.({}, { update: (value) => updates.push(value) });
    return updates;
  }

  it("salts every JS chunk hash, so the bundler names the protected bytes apart from the plain ones", async () => {
    const updates = chunkHashUpdates(await taps({ seed: 1 }));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(chunkHashUpdates(await taps({ seed: 1 }))).toEqual(updates);
    expect(chunkHashUpdates(await taps({ seed: 2 }))).not.toEqual(updates);
    expect(chunkHashUpdates(await taps({ seed: 1, preset: "hard" }))).not.toEqual(updates);
  });

  it("salts the real content hash of JS assets only, keeping its length", async () => {
    const hashTaps = await taps({ seed: 1 });
    const content = [Buffer.from("const a = 1;")];
    const js = hashTaps.updateHash?.(content, "0123456789abcdef");
    expect(js).toMatch(/^[0-9a-f]{16}$/);
    expect(js).not.toBe("0123456789abcdef");
    expect(hashTaps.updateHash?.(content, "fedcba9876543210")).toBeUndefined();
    const other = await taps({ seed: 2 });
    expect(other.updateHash?.(content, "0123456789abcdef")).not.toBe(js);
  });

  it("warns once when webpack offers no realContentHash hook to salt", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const invoke = applyPlugin(
      new AfterpackWebpackPlugin({ seed: 1 }),
      { optimization: { realContentHash: true } },
      { noRealContentHashHooks: true },
    );
    await invoke(fixture({ [JS]: "const a = 1;" }, [JS]));
    const messages = warn.mock.calls.map(([message]) => String(message));
    expect(messages.filter((message) => message.includes("realContentHash"))).toHaveLength(1);
  });

  it("leaves every hash alone when autorun is off", async () => {
    const hashTaps = await taps({ seed: 1, build: { autorun: false } });
    expect(hashTaps.chunkHash).toBeUndefined();
    expect(hashTaps.updateHash).toBeUndefined();
  });
});
