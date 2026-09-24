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
import { type AfterpackEsbuildOptions, afterpackEsbuild } from "./index.js";

let root: string;
let outDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "afterpack-esbuild-test-"));
  outDir = join(root, "dist");
  mkdirSync(outDir, { recursive: true });
  __reset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  __setProcessResult((input) => ({ code: `OBF:${input}`, sourceMap: null, protectionMap: null }));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function applyPlugin(
  options: AfterpackEsbuildOptions,
  initialOptions: Record<string, unknown>,
): (result?: Record<string, unknown>) => Promise<void> {
  let endFn: ((result: unknown) => unknown) | undefined;
  const build = {
    initialOptions,
    onEnd: (fn: typeof endFn) => {
      endFn = fn;
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: exercising the esbuild setup() with a fake build.
  afterpackEsbuild(options).setup(build as any);
  return async (result) => {
    if (!endFn) throw new Error("onEnd was not registered");
    await endFn(result ?? { errors: [], warnings: [] });
  };
}

describe("afterpackEsbuild onEnd", () => {
  it("obfuscates every emitted JS under outdir, defaulting backup off so original source never ships, leaving non-JS untouched", async () => {
    writeFileSync(join(outDir, "app.js"), "export const a = 1;");
    writeFileSync(join(outDir, "worker.mjs"), "export const b = 2;");
    writeFileSync(join(outDir, "styles.css"), ".x{}");

    await applyPlugin({}, { outdir: outDir, absWorkingDir: root, write: true })();

    expect(readFileSync(join(outDir, "app.js"), "utf8")).toContain("OBF:export const a = 1;");
    expect(readFileSync(join(outDir, "worker.mjs"), "utf8")).toContain("OBF:export const b = 2;");
    expect(readFileSync(join(outDir, "styles.css"), "utf8")).toBe(".x{}");
    expect(readdirSync(outDir).some((f) => /\.backup\./.test(f))).toBe(false);
    expect(engineCalls.map((c) => c.input).sort()).toEqual([
      "export const a = 1;",
      "export const b = 2;",
    ]);
  });

  it("resolves a relative outdir against absWorkingDir", async () => {
    writeFileSync(join(outDir, "app.js"), "export const a = 1;");
    await applyPlugin({}, { outdir: "dist", absWorkingDir: root })();
    expect(readFileSync(join(outDir, "app.js"), "utf8")).toContain("OBF:export const a = 1;");
  });

  it("obfuscates a single `outfile` output", async () => {
    const file = join(outDir, "bundle.js");
    writeFileSync(file, "export const a = 1;");
    await applyPlugin({}, { outfile: file, absWorkingDir: root })();
    expect(readFileSync(file, "utf8")).toContain("OBF:export const a = 1;");
  });

  it("skips a write:false build (outputs are in-memory only)", async () => {
    writeFileSync(join(outDir, "app.js"), "export const a = 1;");
    await applyPlugin({}, { outdir: outDir, absWorkingDir: root, write: false })();
    expect(engineCalls).toHaveLength(0);
    expect(readFileSync(join(outDir, "app.js"), "utf8")).toBe("export const a = 1;");
  });

  it("skips when the build already reported errors", async () => {
    writeFileSync(join(outDir, "app.js"), "export const a = 1;");
    const invoke = applyPlugin({}, { outdir: outDir, absWorkingDir: root });
    await invoke({ errors: [{ text: "syntax error" }], warnings: [] });
    expect(engineCalls).toHaveLength(0);
  });

  it("forwards a hand-authored regions array into the shared engine config", async () => {
    writeFileSync(join(outDir, "app.js"), "export const a = 1;");
    const regions = [{ start: 0, end: 12, floor: false }];
    await applyPlugin({ regions }, { outdir: outDir, absWorkingDir: root })();
    expect(engineCalls[0].config.regions).toEqual(regions);
  });

  it("does nothing when build.autorun is disabled via the option", async () => {
    writeFileSync(join(outDir, "app.js"), "export const a = 1;");
    await applyPlugin({ build: { autorun: false } }, { outdir: outDir, absWorkingDir: root })();
    expect(engineCalls).toHaveLength(0);
    expect(existsSync(join(root, ".afterpack"))).toBe(false);
  });

  it("does nothing when AFTERPACK_build_autorun=false is set", async () => {
    const prev = process.env.AFTERPACK_build_autorun;
    process.env.AFTERPACK_build_autorun = "false";
    try {
      writeFileSync(join(outDir, "app.js"), "export const a = 1;");
      await applyPlugin({}, { outdir: outDir, absWorkingDir: root })();
      expect(engineCalls).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.AFTERPACK_build_autorun;
      else process.env.AFTERPACK_build_autorun = prev;
    }
  });

  it("fails the build (throws) when the engine reports an error diagnostic", async () => {
    __setProcessResult(() => ({
      code: "",
      sourceMap: null,
      protectionMap: null,
      diagnostics: [{ severity: "error", message: "boom", code: "DIAG_X" }],
    }));
    writeFileSync(join(outDir, "app.js"), "eval('x');");
    await expect(applyPlugin({}, { outdir: outDir, absWorkingDir: root })()).rejects.toThrow(
      /failed to obfuscate/,
    );
  });
});

const ORIGINAL = [
  "/* @afterpack skip */",
  'const keep = "AAA";',
  "/* @afterpack end */",
  'const drop = "BBB";',
].join("\n");
const CHUNK = 'const keep="AAA";const drop="BBB";';
const KEEP_LEN = 'const keep="AAA";'.length;
const VLQ_MAPPINGS_KEEP_THEN_DROP = "AACA,iBAEA";

function writeChunk(withMap: boolean): void {
  const file = join(outDir, "app.js");
  writeFileSync(file, withMap ? `${CHUNK}\n//# sourceMappingURL=app.js.map\n` : `${CHUNK}\n`);
  if (!withMap) return;
  writeFileSync(
    `${file}.map`,
    JSON.stringify({
      version: 3,
      sources: ["src/mod.js"],
      sourcesContent: [ORIGINAL],
      names: [],
      mappings: VLQ_MAPPINGS_KEEP_THEN_DROP,
    }),
  );
}

describe("afterpackEsbuild per-region directives", () => {
  it("recovers directives from the emitted map's sourcesContent BY DEFAULT", async () => {
    writeChunk(true);
    await applyPlugin({}, { outdir: outDir, absWorkingDir: root })();
    const regions = engineCalls[0].regions as Array<Record<string, unknown>>;
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({ start: 0, end: KEEP_LEN, target: 0, floor: false });
  });

  it("scans nothing when the user turns directives off", async () => {
    writeChunk(true);
    await applyPlugin(
      { directives: { enabled: false } },
      { outdir: outDir, absWorkingDir: root },
    )();
    expect(engineCalls).toHaveLength(1);
    expect(engineCalls[0].regions).toBeUndefined();
  });

  it("warns (never silently no-ops) when opted in with no usable source map", async () => {
    writeChunk(false);
    await applyPlugin({ directives: { enabled: true } }, { outdir: outDir, absWorkingDir: root })();
    expect(engineCalls[0].regions).toBeUndefined();
    const warned = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));
    expect(warned.some((w) => w.includes("No directive was applied to this build."))).toBe(true);
  });

  it("stays QUIET about missing maps when nobody asked for directives", async () => {
    writeChunk(false);
    await applyPlugin({}, { outdir: outDir, absWorkingDir: root })();
    const warned = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));
    expect(warned.some((w) => w.includes("No directive was applied to this build."))).toBe(false);
  });
});

describe("afterpackEsbuild afterpack.json (resolved from process.cwd, not esbuild's absWorkingDir)", () => {
  beforeEach(() => {
    vi.spyOn(process, "cwd").mockReturnValue(root);
  });

  it("reaches the engine when the plugin was given no options at all", async () => {
    writeFileSync(join(root, "afterpack.json"), JSON.stringify({ preset: "hard" }));
    writeFileSync(join(outDir, "app.js"), "export const a = 1;");

    await applyPlugin({}, { outdir: outDir, absWorkingDir: root, write: true })();

    expect(engineCalls[0].config.preset).toBe("hard");
  });

  it("is outranked by the plugin options object", async () => {
    writeFileSync(join(root, "afterpack.json"), JSON.stringify({ preset: "hard" }));
    writeFileSync(join(outDir, "app.js"), "export const a = 1;");

    await applyPlugin({ preset: "medium" }, { outdir: outDir, absWorkingDir: root, write: true })();

    expect(engineCalls[0].config.preset).toBe("medium");
  });

  it("fails the build on an unknown key instead of silently dropping it", () => {
    writeFileSync(join(root, "afterpack.json"), JSON.stringify({ level: "medium" }));
    expect(() => afterpackEsbuild({})).toThrow(/unknown configuration key `level`/);
  });
});
