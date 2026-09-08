import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __reset, __setProcessResult, engineCalls } from "../../../test/core-fake.js";
import { resetBuildSessions } from "../../integration-utils/src/seed.js";
import { type AfterpackViteOptions, afterpackVite } from "./index.js";

let root: string;
let outDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "afterpack-vite-config-"));
  outDir = join(root, "dist");
  mkdirSync(outDir, { recursive: true });
  resetBuildSessions();
  __reset();
  vi.spyOn(process, "cwd").mockReturnValue(root);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  __setProcessResult((input) => ({ code: `OBF:${input}`, sourceMap: null, protectionMap: null }));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  delete process.env.AFTERPACK_preset;
});

function writeConfigFile(config: Record<string, unknown>): void {
  writeFileSync(join(root, "afterpack.json"), JSON.stringify(config));
}

async function run(options: AfterpackViteOptions = {}): Promise<Record<string, unknown>> {
  const plugin = afterpackVite(options);
  // biome-ignore lint/suspicious/noExplicitAny: exercising Vite hooks directly in a test.
  const p = plugin as any;
  p.configResolved({ root, build: { outDir } });
  await p.generateBundle.handler.call(
    {},
    { dir: outDir },
    {
      "index.js": { type: "chunk", fileName: "index.js", code: "export const a = 1;", modules: {} },
    },
  );
  return JSON.parse(engineCalls[engineCalls.length - 1].configJson) as Record<string, unknown>;
}

describe("afterpackVite reads afterpack.json (options outrank AFTERPACK_* outrank the file)", () => {
  it("forwards the file's engine keys with no plugin option set", async () => {
    writeConfigFile({ preset: "hard", strings: { minLength: 4 } });
    const config = await run();
    expect(config.preset).toBe("hard");
    expect(config.strings).toMatchObject({ minLength: 4 });
  });

  it("lets a plugin option outrank the file", async () => {
    writeConfigFile({ preset: "hard" });
    expect((await run({ preset: "medium" })).preset).toBe("medium");
  });

  it("lets the environment outrank the file and lose to a plugin option", async () => {
    writeConfigFile({ preset: "hard" });
    process.env.AFTERPACK_preset = "extreme";
    expect((await run()).preset).toBe("extreme");
    expect((await run({ preset: "light" })).preset).toBe("light");
  });

  it("applies a file-set protectionMap.enabled to the artifact policy", async () => {
    writeConfigFile({ protectionMap: { enabled: false } });
    expect((await run()).protectionMap).toMatchObject({ enabled: false });
  });

  it("refuses an unknown key in the file, naming the canonical spelling", () => {
    writeConfigFile({ presset: "hard" });
    expect(() => afterpackVite()).toThrow(/unknown configuration key `presset`.*did you mean/s);
  });

  it("refuses an unknown key in the options object", () => {
    expect(() => afterpackVite({ complexity: "hard" } as unknown as AfterpackViteOptions)).toThrow(
      /complexity/,
    );
  });

  it("accepts the options this plugin owns that are not configuration", () => {
    expect(() => afterpackVite({ leg: "main", projectRoot: root, git: false })).not.toThrow();
  });
});
