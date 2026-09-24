import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import webpack, { type Compiler, type WebpackPluginInstance } from "webpack";
import { __reset, __setProcessResult, engineCalls } from "../../../test/core-fake.js";
import { type AfterpackWebpackOptions, AfterpackWebpackPlugin } from "./index.js";

const PRELUDE = 'export const PRELUDE = "PRELUDE_MARKER_PADDING_PADDING_PADDING_PADDING";\n';
const OTHER = 'export const other = "OTHER_CHUNK_MARKER_PADDING_PADDING";\n';
const ENTRY = [
  'import { PRELUDE } from "./prelude.js";',
  "export function hot(a) {",
  "  let out = PRELUDE;",
  "  /* @afterpack skip */",
  '  for (let i = 0; i < a; i++) out += "REGION_INSIDE_MARKER" + i;',
  "  /* @afterpack end */",
  "  return out;",
  "}",
  'export const cold = "REGION_OUTSIDE_MARKER";',
  'console.log(hot(3), cold, import("./other.js"));',
].join("\n");

let root: string;
let outDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "afterpack-webpack-backcolor-"));
  outDir = join(root, "dist");
  __reset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  __setProcessResult((input) => ({ code: input, sourceMap: null, protectionMap: null }));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeProject(): string {
  writeFileSync(join(root, "prelude.js"), PRELUDE);
  writeFileSync(join(root, "other.js"), OTHER);
  const entry = join(root, "entry.js");
  writeFileSync(entry, ENTRY);
  return entry;
}

interface BuildOverrides {
  options?: AfterpackWebpackOptions;
  cacheDirectory?: string;
  out?: string;
  extra?: WebpackPluginInstance;
}

function entryLoaderRunCounter(counter: { n: number }): WebpackPluginInstance {
  return {
    apply(compiler: Compiler) {
      compiler.hooks.compilation.tap("count", (compilation) => {
        const hooks = compiler.webpack.NormalModule.getCompilationHooks(compilation);
        hooks.beforeLoaders.tap("count", (_loaders, module) => {
          if (module.resource.endsWith("entry.js")) counter.n++;
        });
      });
    },
  };
}

function build(devtool: false | "source-map", overrides: BuildOverrides = {}): Promise<void> {
  const { options = {}, cacheDirectory, out = ".", extra } = overrides;
  return new Promise((resolve, reject) => {
    webpack(
      {
        mode: "production",
        context: root,
        entry: writeProject(),
        devtool,
        cache: cacheDirectory ? { type: "filesystem", cacheDirectory } : false,
        output: {
          path: join(outDir, out),
          filename: "main.js",
          chunkFilename: "async.js",
        },
        infrastructureLogging: { level: "error" },
        plugins: extra
          ? [new AfterpackWebpackPlugin(options), extra]
          : [new AfterpackWebpackPlugin(options)],
      },
      (err, stats) => {
        if (err) return reject(err);
        if (stats?.hasErrors()) return reject(new Error(stats.toString({ preset: "errors-only" })));
        resolve();
      },
    );
  });
}

function callWith(marker: string) {
  const hit = engineCalls.filter((c) => c.input.includes(marker));
  expect(hit, `exactly one emitted chunk carries ${marker}`).toHaveLength(1);
  return hit[0];
}

describe("directive capture through a real production webpack build (terser strips the comment)", () => {
  it("colors a directive onto the emitted chunk bytes it governs, and no others", async () => {
    await build("source-map");

    const main = callWith("REGION_INSIDE_MARKER");
    expect(
      main.input,
      "terser stripped the directive comment, so any region came from pre-minify capture",
    ).not.toContain("@afterpack");
    expect(main.input).toContain("REGION_OUTSIDE_MARKER");
    expect(main.input).toContain("PRELUDE_MARKER");

    const regions = main.regions as Array<{
      start: number;
      end: number;
      target?: number;
      floor?: boolean;
    }>;
    expect(regions.length, "the directive colored to >=1 chunk range").toBeGreaterThan(0);

    const covered = regions.map((r) => main.input.slice(r.start, r.end)).join(" ");
    expect(covered).toContain("REGION_INSIDE_MARKER");
    expect(covered).not.toContain("REGION_OUTSIDE_MARKER");
    expect(covered).not.toContain("PRELUDE_MARKER");
    expect(covered).not.toContain("OTHER_CHUNK_MARKER");

    const originalStart = ENTRY.indexOf("/* @afterpack skip */");
    const originalEnd = ENTRY.indexOf("/* @afterpack end */");
    expect(
      regions[0].start,
      "real coloring, not a pass-through of the original source span",
    ).not.toBe(originalStart);
    expect(main.input.slice(originalStart, originalEnd)).not.toContain("REGION_INSIDE_MARKER");

    for (const r of regions) {
      expect(r.end).toBeLessThanOrEqual(Buffer.byteLength(main.input, "utf8"));
      expect(r.end).toBeGreaterThan(r.start);
      expect(r).toMatchObject({ target: 0, floor: false });
    }

    expect(
      callWith("OTHER_CHUNK_MARKER").regions,
      "the async chunk holds no directive-bearing module",
    ).toBeUndefined();
  }, 60_000);

  it("says so (never silently) when the build emits no source map to color through", async () => {
    await build(false);

    expect(callWith("REGION_INSIDE_MARKER").regions).toBeUndefined();
    const warned = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));
    expect(warned.some((w) => /no source map/i.test(w))).toBe(true);
  }, 60_000);

  it("captures nothing when directives are disabled", async () => {
    await build("source-map", { options: { directives: false } });

    for (const call of engineCalls) expect(call.regions).toBeUndefined();
  }, 60_000);

  it("still colors when a WARM persistent cache restores the module past every build hook", async () => {
    const cacheDirectory = join(root, ".webpack-cache");
    const built = { n: 0 };
    await build("source-map", { cacheDirectory, out: "cold", extra: entryLoaderRunCounter(built) });
    const cold = callWith("REGION_INSIDE_MARKER").regions;
    expect(cold).toBeDefined();
    expect(built.n, "the cold build ran the module through its loaders").toBe(1);

    __reset();
    built.n = 0;
    await build("source-map", { cacheDirectory, out: "warm", extra: entryLoaderRunCounter(built) });
    expect(built.n, "the warm build restored the module past every build hook").toBe(0);
    expect(callWith("REGION_INSIDE_MARKER").regions).toEqual(cold);
  }, 120_000);
});
