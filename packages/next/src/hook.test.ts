import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTECTION_RECEIPT_FILE,
  type ProtectionReceipt,
  sha256Of,
  verifyProtectionReceipt,
} from "@afterpack/integration-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __reset, __setProcessResult, engineCalls, processBatch } from "../../../test/core-fake.js";
import { runAfterpackHook, stripServedSourceMaps } from "./hook.js";

const BUILD_ID = "test-build-id";
const engine = { processBatch, version: async () => "9.9.9-test" };
const env: NodeJS.ProcessEnv = { AFTERPACK_telemetry_enabled: "false" };

let root: string;

interface Project {
  projectDir: string;
  distDir: string;
  chunksDir: string;
}

function projectAsNextLeavesItAtHookTime(bundler: "turbopack" | "webpack" = "turbopack"): Project {
  const projectDir = mkdtempSync(join(root, "app-"));
  const distDir = join(projectDir, ".next");
  const chunksDir = join(distDir, "static", "chunks");
  mkdirSync(chunksDir, { recursive: true });
  writeFileSync(
    join(distDir, "build-manifest.json"),
    JSON.stringify({ lowPriorityFiles: [`static/${BUILD_ID}/_buildManifest.js`] }),
  );
  if (bundler === "turbopack") {
    writeFileSync(join(distDir, "turbopack"), "");
  } else {
    mkdirSync(join(distDir, "server"), { recursive: true });
    writeFileSync(join(distDir, "server", "webpack-runtime.js"), "var r=1;");
  }
  return { projectDir, distDir, chunksDir };
}

const project = projectAsNextLeavesItAtHookTime;

function chunk(p: Project, name: string, source: string): string {
  const path = join(p.chunksDir, name);
  writeFileSync(path, source);
  return path;
}

function receiptOf(p: Project): ProtectionReceipt {
  return JSON.parse(readFileSync(join(p.distDir, PROTECTION_RECEIPT_FILE), "utf8"));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "afterpack-next-hook-"));
  __reset();
  __setProcessResult((input) => ({ code: `OBF:${input}`, sourceMap: null, protectionMap: null }));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("runAfterpackHook", () => {
  it("obfuscates every client chunk under distDir/static/chunks", async () => {
    const p = project();
    const a = chunk(p, "main.js", "export const a = 1;");
    const b = chunk(p, "vendor.js", "export const b = 2;");

    await runAfterpackHook({ metadata: p, options: {}, engine, env });

    expect(readFileSync(a, "utf8")).toContain("OBF:export const a = 1;");
    expect(readFileSync(b, "utf8")).toContain("OBF:export const b = 2;");
  });

  it("REFUSES experimental.sri rather than silently invalidating every integrity hash", async () => {
    const p = project();
    chunk(p, "main.js", "export const a = 1;");

    await expect(
      runAfterpackHook({ metadata: p, options: {}, sriAlgorithm: "sha256", engine, env }),
    ).rejects.toThrow(/experimental\.sri` is not compatible/);
    expect(engineCalls).toHaveLength(0);
  });

  it("REFUSES sri it finds in the build output even when the wrapped config hid it", async () => {
    const p = project();
    chunk(p, "main.js", "export const a = 1;");
    mkdirSync(join(p.distDir, "server"), { recursive: true });
    writeFileSync(join(p.distDir, "server", "subresource-integrity-manifest.json"), "{}");

    await expect(runAfterpackHook({ metadata: p, options: {}, engine, env })).rejects.toThrow(
      /experimental\.sri` is not compatible/,
    );
    expect(engineCalls).toHaveLength(0);
  });

  it("fails the build when there is no client JS, rather than reporting a protected tree", async () => {
    const p = project();

    await expect(runAfterpackHook({ metadata: p, options: {}, engine, env })).rejects.toThrow(
      /no client JS found/,
    );
    expect(existsSync(join(p.distDir, PROTECTION_RECEIPT_FILE))).toBe(false);
  });

  it("skips on build.autorun=false, from the options object or the environment", async () => {
    const a = project();
    chunk(a, "main.js", "export const a = 1;");
    await runAfterpackHook({ metadata: a, options: { build: { autorun: false } }, engine, env });

    const b = project();
    chunk(b, "main.js", "export const a = 1;");
    await runAfterpackHook({
      metadata: b,
      options: {},
      engine,
      env: { ...env, AFTERPACK_build_autorun: "false" },
    });

    expect(engineCalls).toHaveLength(0);
    expect(existsSync(join(a.distDir, PROTECTION_RECEIPT_FILE))).toBe(false);
  });
});

describe("the protection receipt", () => {
  it("records the engine, seed, bundler, the build id from build-manifest.json (no BUILD_ID file yet) and a sha256 per obfuscated file", async () => {
    const p = project();
    const main = chunk(p, "main.js", "export const a = 1;");

    await runAfterpackHook({ metadata: p, options: { seed: 4242 }, engine, env });

    const receipt = receiptOf(p);
    expect(receipt).toMatchObject({
      schema: 1,
      tool: "afterpack-next",
      engineVersion: "9.9.9-test",
      seed: "4242",
      bundler: "turbopack",
      buildId: BUILD_ID,
    });
    expect(
      receipt.files,
      "hashed after the whole pass, so the receipt describes shipped bytes",
    ).toEqual([{ path: "static/chunks/main.js", sha256: sha256Of(main), transformed: true }]);
  });

  it("names the webpack bundler when webpack produced the tree", async () => {
    const p = project("webpack");
    chunk(p, "main.js", "export const a = 1;");

    await runAfterpackHook({ metadata: p, options: {}, engine, env });

    expect(receiptOf(p).bundler).toBe("webpack");
  });

  it("verifies clean straight after the build, and catches a chunk replaced afterwards", async () => {
    const p = project();
    const main = chunk(p, "main.js", "export const a = 1;");

    await runAfterpackHook({ metadata: p, options: {}, engine, env });
    expect(verifyProtectionReceipt(p.distDir, BUILD_ID).problems).toEqual([]);

    writeFileSync(main, "export const a = 1;");
    expect(verifyProtectionReceipt(p.distDir, BUILD_ID).problems).toEqual([
      "static/chunks/main.js: content changed since it was obfuscated",
    ]);
  });

  it("catches a receipt left over from an earlier build of the same tree", async () => {
    const p = project();
    chunk(p, "main.js", "export const a = 1;");

    await runAfterpackHook({ metadata: p, options: {}, engine, env });

    expect(verifyProtectionReceipt(p.distDir, "a-later-build").problems).toEqual([
      expect.stringContaining("rebuilt without the AfterPack wrapper"),
    ]);
  });
});

describe("stripServedSourceMaps", () => {
  it("deletes every served .js.map and strips the now-dangling trailer", () => {
    const p = project();
    const main = chunk(p, "main.js", "var a=1;\n//# sourceMappingURL=main.js.map\n");
    writeFileSync(join(p.chunksDir, "main.js.map"), '{"version":3}');
    mkdirSync(join(p.chunksDir, "app"), { recursive: true });
    const nested = join(p.chunksDir, "app", "page.js");
    writeFileSync(nested, "var b=2;");
    writeFileSync(join(p.chunksDir, "app", "page.js.map"), '{"version":3}');

    stripServedSourceMaps([main, nested], p.chunksDir);

    expect(existsSync(join(p.chunksDir, "main.js.map"))).toBe(false);
    expect(existsSync(join(p.chunksDir, "app", "page.js.map"))).toBe(false);
    expect(readFileSync(main, "utf8")).toBe("var a=1;\n");
    expect(readFileSync(nested, "utf8")).toBe("var b=2;");
  });

  it("is a no-op (no throw) when there are no served maps", () => {
    const p = project();
    const main = chunk(p, "main.js", "var a=1;");

    expect(() => stripServedSourceMaps([main], p.chunksDir)).not.toThrow();
    expect(readFileSync(main, "utf8")).toBe("var a=1;");
  });
});
