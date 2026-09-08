import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __reset, __setProcessResult, engineCalls } from "../../../test/core-fake.js";
import { type AfterpackRollupOptions, afterpackRollup } from "./index.js";

let root: string;
let outDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "afterpack-rollup-config-"));
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
  delete process.env.AFTERPACK_complexity;
});

async function run(options: AfterpackRollupOptions = {}): Promise<Record<string, unknown>> {
  const plugin = afterpackRollup(options);
  const bundle = {
    "index.js": { type: "chunk", fileName: "index.js", code: "export const a = 1;", modules: {} },
  };
  // biome-ignore lint/suspicious/noExplicitAny: exercising the Rollup hook directly in a test.
  await (plugin.generateBundle as any).handler.call({}, { dir: outDir }, bundle);
  return JSON.parse(engineCalls[engineCalls.length - 1].configJson) as Record<string, unknown>;
}

describe("afterpackRollup reads afterpack.json", () => {
  it("forwards the file's engine keys", async () => {
    writeFileSync(
      join(root, "afterpack.json"),
      JSON.stringify({ preset: "hard", identifiers: { rename: false } }),
    );
    const config = await run();
    expect(config.preset).toBe("hard");
    expect(config.identifiers).toMatchObject({ rename: false });
  });

  it("ranks a plugin option above the environment above the file", async () => {
    writeFileSync(join(root, "afterpack.json"), JSON.stringify({ complexity: 1 }));
    expect(await run()).toMatchObject({ complexity: 1 });
    process.env.AFTERPACK_complexity = "9";
    expect(await run()).toMatchObject({ complexity: 9 });
    expect(await run({ complexity: 40 })).toMatchObject({ complexity: 40 });
  });

  it("refuses a malformed value in the file", () => {
    writeFileSync(join(root, "afterpack.json"), JSON.stringify({ preset: "nope" }));
    expect(() => afterpackRollup()).toThrow(/minify, light, medium, hard, extreme/);
  });
});
