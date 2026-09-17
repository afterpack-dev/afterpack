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
import { __reset, __setProcessResult, engineCalls } from "../../../test/core-fake.js";
import { type AfterpackRollupOptions, afterpackRollup } from "./index.js";

let root: string;
let outDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "afterpack-rollup-test-"));
  outDir = join(root, "dist");
  mkdirSync(outDir, { recursive: true });
  __reset();
  vi.spyOn(process, "cwd").mockReturnValue(root);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  __setProcessResult((input) => ({ code: `OBF:${input}`, sourceMap: null, protectionMap: null }));
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

function asset(fileName: string, source: string): BundleEntry {
  return { type: "asset", fileName, source };
}

function bundleOf(...entries: BundleEntry[]): Record<string, BundleEntry> {
  return Object.fromEntries(entries.map((e) => [e.fileName, e]));
}

async function runPlugin(
  options: AfterpackRollupOptions,
  outputOptions: Record<string, unknown>,
  bundle: Record<string, BundleEntry> = {},
): Promise<Record<string, BundleEntry>> {
  const plugin = afterpackRollup(options);
  // biome-ignore lint/suspicious/noExplicitAny: exercising the Rollup hook directly in a test.
  await (plugin.generateBundle as any).handler.call({}, outputOptions, bundle);
  return bundle;
}

describe("afterpackRollup generateBundle", () => {
  it("obfuscates every JS entry in the bundle, leaving non-JS untouched", async () => {
    const bundle = await runPlugin(
      {},
      { dir: outDir },
      bundleOf(
        chunk("index.js", "export const a = 1;"),
        chunk("chunks/dep.mjs", "export const b = 2;"),
        asset("styles.css", ".x{}"),
        asset("vendor.js", "window.v = 1;"),
      ),
    );

    expect(bundle["index.js"].code).toBe("OBF:export const a = 1;");
    expect(bundle["chunks/dep.mjs"].code).toBe("OBF:export const b = 2;");
    expect(bundle["styles.css"].source).toBe(".x{}");
    expect(bundle["vendor.js"].source).toBe("OBF:window.v = 1;");
    expect(engineCalls.map((c) => c.input).sort()).toEqual([
      "export const a = 1;",
      "export const b = 2;",
      "window.v = 1;",
    ]);
    expect(readdirSync(outDir)).toEqual([]);
  });

  it("derives the output dir from a single `file` output", async () => {
    const bundle = await runPlugin(
      {},
      { file: join(outDir, "bundle.cjs") },
      bundleOf(chunk("bundle.cjs", "module.exports = 1;")),
    );
    expect(bundle["bundle.cjs"].code).toBe("OBF:module.exports = 1;");
  });

  it("forwards a hand-authored regions array into the shared engine config", async () => {
    const regions = [{ start: 0, end: 12, floor: false }];
    await runPlugin({ regions }, { dir: outDir }, bundleOf(chunk("a.js", "export const a = 1;")));
    expect(JSON.parse(engineCalls[0].configJson).regions).toEqual(regions);
  });

  it("does nothing when build.autorun is disabled via the option", async () => {
    const bundle = await runPlugin(
      { build: { autorun: false } },
      { dir: outDir },
      bundleOf(chunk("a.js", "export const a = 1;")),
    );
    expect(bundle["a.js"].code).toBe("export const a = 1;");
    expect(engineCalls).toHaveLength(0);
  });

  it("does nothing when AFTERPACK_build_autorun=false is set", async () => {
    const prev = process.env.AFTERPACK_build_autorun;
    process.env.AFTERPACK_build_autorun = "false";
    try {
      await runPlugin({}, { dir: outDir }, bundleOf(chunk("a.js", "export const a = 1;")));
      expect(engineCalls).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.AFTERPACK_build_autorun;
      else process.env.AFTERPACK_build_autorun = prev;
    }
  });

  it("no-ops when the bundle holds no JS (no engine call, no artifacts)", async () => {
    await runPlugin({}, { dir: outDir }, bundleOf(asset("styles.css", ".x{}")));
    expect(engineCalls).toHaveLength(0);
    expect(existsSync(join(root, ".afterpack"))).toBe(false);
  });

  it("fails the build (throws) and leaves the bundle's own bytes in place", async () => {
    __setProcessResult(() => ({
      code: "",
      sourceMap: null,
      protectionMap: null,
      diagnostics: [{ severity: "error", message: "boom", code: "DIAG_X" }],
    }));
    const bundle = bundleOf(chunk("a.js", "eval('x');"));
    await expect(runPlugin({}, { dir: outDir }, bundle)).rejects.toThrow(/failed to obfuscate/);
    expect(bundle["a.js"].code).toBe("eval('x');");
    expect(readdirSync(outDir)).toEqual([]);
  });
});

describe("afterpackRollup writeBundle (protection receipt)", () => {
  it("writes .afterpack-protection.json in writeBundle for the files rollup actually wrote", async () => {
    const plugin = afterpackRollup({});
    const outputOptions = { dir: outDir };
    const bundle = bundleOf(chunk("index.js", "export const a = 1;"));
    // biome-ignore lint/suspicious/noExplicitAny: exercising the Rollup hooks directly in a test.
    const p = plugin as any;
    await p.generateBundle.handler.call({}, outputOptions, bundle);
    const emitted = bundle["index.js"].code;
    if (emitted === undefined) throw new Error("the pass left the chunk with no code");
    writeFileSync(join(outDir, "index.js"), emitted);
    await p.writeBundle(outputOptions, bundle);

    const receiptPath = join(outDir, ".afterpack-protection.json");
    expect(existsSync(receiptPath)).toBe(true);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    expect(receipt.files.map((f: { path: string }) => f.path)).toEqual(["index.js"]);
  });

  it("does not write a receipt for a file rollup never flushed to disk", async () => {
    const plugin = afterpackRollup({});
    const outputOptions = { dir: outDir };
    const bundle = bundleOf(chunk("index.js", "export const a = 1;"));
    // biome-ignore lint/suspicious/noExplicitAny: exercising the Rollup hooks directly in a test.
    const p = plugin as any;
    await p.generateBundle.handler.call({}, outputOptions, bundle);
    await p.writeBundle(outputOptions, bundle);

    expect(existsSync(join(outDir, ".afterpack-protection.json"))).toBe(false);
  });
});

describe("afterpackRollup source maps", () => {
  const MAP = '{"version":3,"sources":["a.js"],"mappings":""}';

  function mapped(): Record<string, BundleEntry> {
    return bundleOf(
      chunk("index.js", "const a=1;\n//# sourceMappingURL=index.js.map\n", {
        map: { toString: () => MAP },
        sourcemapFileName: "index.js.map",
      }),
      asset("index.js.map", MAP),
    );
  }

  it("reads Rollup's live map and replaces its bundle entry with the map the obfuscation pass returns", async () => {
    __setProcessResult((input) => ({
      code: `OBF:${input}`,
      sourceMap: '{"version":3,"sources":["a.js"],"mappings":"AAAA"}',
      protectionMap: null,
    }));
    const bundle = await runPlugin(
      { sourceMap: { enabled: true, emitUrl: true } },
      { dir: outDir, sourcemap: true },
      mapped(),
    );
    expect(engineCalls[0].inputSourceMap).toBe(MAP);
    expect(bundle["index.js.map"].source).toContain('"mappings":"AAAA"');
    expect(bundle["index.js"].code).toMatch(/\/\/# sourceMappingURL=index\.js\.map\n$/);
  });

  it("drops the bundler's own map entry when policy ships none", async () => {
    const bundle = await runPlugin(
      { sourceMap: false, production: true, protectionMap: false },
      { dir: outDir, sourcemap: true },
      mapped(),
    );
    expect(bundle["index.js.map"]).toBeUndefined();
    expect(bundle["index.js"].code).not.toContain("sourceMappingURL");
  });
});

const MODULE_ID = "/project/src/mod.js";
const MODULE_SOURCE = [
  "/* @afterpack skip */",
  'const keep = "AAA";',
  "/* @afterpack end */",
  'const drop = "BBB";',
].join("\n");
const CHUNK_CODE = 'const keep="AAA";const drop="BBB";';
const KEEP_LEN = 'const keep="AAA";'.length;

const VLQ_MAPPINGS_KEEP_THEN_DROP = "AACA,iBAEA";

function chunkMap(): string {
  return JSON.stringify({
    version: 3,
    sources: ["src/mod.js"],
    names: [],
    mappings: VLQ_MAPPINGS_KEEP_THEN_DROP,
  });
}

async function runCapture(options: AfterpackRollupOptions, source = MODULE_SOURCE): Promise<void> {
  const plugin = afterpackRollup(options);
  // biome-ignore lint/suspicious/noExplicitAny: exercising the Rollup hooks directly.
  const p = plugin as any;
  p.transform.handler.call({}, source, MODULE_ID);
  await p.generateBundle.handler.call(
    {},
    { dir: outDir, sourcemap: true },
    bundleOf(
      chunk("index.js", CHUNK_CODE, {
        modules: { [MODULE_ID]: {} },
        map: { toString: () => chunkMap() },
        sourcemapFileName: "index.js.map",
      }),
      asset("index.js.map", chunkMap()),
    ),
  );
}

describe("afterpackRollup directive capture (backward-coloring)", () => {
  it("colors a captured directive onto the emitted chunk's own bytes", async () => {
    await runCapture({});
    expect(engineCalls).toHaveLength(1);
    const regions = JSON.parse(engineCalls[0].regions as string) as Array<Record<string, unknown>>;
    expect(regions).toHaveLength(1);
    expect(
      regions[0],
      "keep statement only — the drop statement is outside the directive block",
    ).toMatchObject({ start: 0, end: KEEP_LEN, target: 0, floor: false });
  });

  it("sends no per-file regions when directives are disabled", async () => {
    await runCapture({ directives: false });
    expect(engineCalls).toHaveLength(1);
    expect(engineCalls[0].regions).toBeUndefined();
  });

  it("warns (never silently drops) a `// @afterpack` line comment", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runCapture({}, "// @afterpack skip\nconst keep = 1;\n");
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes("line comments are not scanned"))).toBe(true);
    expect(engineCalls[0].regions).toBeUndefined();
  });

  it("ignores node_modules and virtual module ids", async () => {
    const plugin = afterpackRollup({});
    // biome-ignore lint/suspicious/noExplicitAny: exercising the Rollup hook directly.
    const handler = (plugin as any).transform.handler;
    expect(handler.call({}, MODULE_SOURCE, "/p/node_modules/x/index.js")).toBeNull();
    expect(handler.call({}, MODULE_SOURCE, "\0virtual:mod.js")).toBeNull();
    expect(handler.call({}, MODULE_SOURCE, "/p/styles.css")).toBeNull();
  });
});

describe("afterpackRollup afterpack.json", () => {
  it("reaches the engine when the plugin was given no options at all", async () => {
    writeFileSync(join(root, "afterpack.json"), JSON.stringify({ preset: "hard" }));
    await runPlugin({}, { dir: outDir }, bundleOf(chunk("index.js", "export const a = 1;")));
    expect(JSON.parse(engineCalls[0].configJson).preset).toBe("hard");
  });

  it("is outranked by the plugin options object", async () => {
    writeFileSync(join(root, "afterpack.json"), JSON.stringify({ preset: "hard" }));
    await runPlugin(
      { preset: "medium" },
      { dir: outDir },
      bundleOf(chunk("index.js", "export const a = 1;")),
    );
    expect(JSON.parse(engineCalls[0].configJson).preset).toBe("medium");
  });

  it("fails the build on an unknown key instead of silently dropping it", () => {
    writeFileSync(join(root, "afterpack.json"), JSON.stringify({ level: "medium" }));
    expect(() => afterpackRollup({})).toThrow(/unknown configuration key `level`/);
  });

  it("refuses `paths.include`, which this plugin has no disk walk to apply", () => {
    writeFileSync(
      join(root, "afterpack.json"),
      JSON.stringify({ paths: { include: ["**/node_modules/**"] } }),
    );
    expect(() => afterpackRollup({})).toThrow(/`paths.include` is not supported here/);
  });
});
