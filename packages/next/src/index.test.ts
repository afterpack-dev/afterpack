import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTECTION_RECEIPT_FILE } from "@afterpack/integration-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __reset, __setProcessResult } from "../../../test/core-fake.js";
import { withAfterpack } from "./index.js";

interface Wrapped {
  compiler?: {
    runAfterProductionCompile?: (m: { projectDir: string; distDir: string }) => Promise<void>;
  };
}

let root: string;

function projectWithBuiltChunk(): { projectDir: string; distDir: string; chunk: string } {
  const projectDir = mkdtempSync(join(root, "app-"));
  const distDir = join(projectDir, ".next");
  const chunks = join(distDir, "static", "chunks");
  mkdirSync(chunks, { recursive: true });
  const chunk = join(chunks, "main.js");
  writeFileSync(chunk, "export const secret = 1;");
  return { projectDir, distDir, chunk };
}

function hookOf(config: object): (m: { projectDir: string; distDir: string }) => Promise<void> {
  const hook = (config as Wrapped).compiler?.runAfterProductionCompile;
  if (!hook) throw new Error("withAfterpack did not install runAfterProductionCompile");
  return hook;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "afterpack-next-config-"));
  __reset();
  __setProcessResult((input) => ({ code: `OBF:${input}`, sourceMap: null, protectionMap: null }));
  vi.stubEnv("AFTERPACK_telemetry_enabled", "false");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("withAfterpack", () => {
  it("carries the user's config through and adds the build hook", () => {
    const wrapped = withAfterpack({ reactStrictMode: true, compiler: { removeConsole: true } });
    expect(wrapped).toMatchObject({ reactStrictMode: true, compiler: { removeConsole: true } });
    expect(typeof hookOf(wrapped)).toBe("function");
  });

  it("obfuscates the client chunks from `next build` alone — no postbuild, no options file", async () => {
    const { projectDir, distDir, chunk } = projectWithBuiltChunk();
    await hookOf(withAfterpack({}, { preset: "hard" }))({ projectDir, distDir });

    expect(readFileSync(chunk, "utf8")).toContain("OBF:export const secret = 1;");
    expect(existsSync(join(projectDir, ".afterpack", "next-options.json"))).toBe(false);
    expect(existsSync(join(distDir, PROTECTION_RECEIPT_FILE))).toBe(true);
  });

  it("carries options straight into the engine, with no second resolution to drop them", async () => {
    const { projectDir, distDir } = projectWithBuiltChunk();
    await hookOf(withAfterpack({}, { strings: { encode: false }, preset: "medium" }))({
      projectDir,
      distDir,
    });

    const { engineCalls } = await import("../../../test/core-fake.js");
    const config = engineCalls[0].config as {
      strings?: { encode?: boolean };
      preset?: string;
    };
    expect(config.strings?.encode).toBe(false);
    expect(config.preset).toBe("medium");
  });

  it("COMPOSES with a user-supplied runAfterProductionCompile — theirs first, ours last", async () => {
    const { projectDir, distDir, chunk } = projectWithBuiltChunk();
    const seen: string[] = [];
    const wrapped = withAfterpack({
      compiler: {
        runAfterProductionCompile: async () => {
          seen.push(readFileSync(chunk, "utf8"));
        },
      },
    });

    await hookOf(wrapped)({ projectDir, distDir });

    expect(seen).toEqual(["export const secret = 1;"]);
    expect(readFileSync(chunk, "utf8")).toContain("OBF:");
  });

  it("accepts Next's other config form, the (phase, ctx) => config function", async () => {
    const { projectDir, distDir, chunk } = projectWithBuiltChunk();
    const wrapped = withAfterpack(
      async (phase: string) => ({ reactStrictMode: phase === "phase-production-build" }),
      { seed: 7 },
    );

    const produced = (await (wrapped as (p: string) => Promise<object>)(
      "phase-production-build",
    )) as { reactStrictMode?: boolean };
    expect(produced.reactStrictMode).toBe(true);
    await hookOf(produced)({ projectDir, distDir });
    expect(readFileSync(chunk, "utf8")).toContain("OBF:");
  });

  it("lets a throwing user hook abort the build before anything is obfuscated", async () => {
    const { projectDir, distDir, chunk } = projectWithBuiltChunk();
    const wrapped = withAfterpack({
      compiler: {
        runAfterProductionCompile: async () => {
          throw new Error("user hook said no");
        },
      },
    });

    await expect(hookOf(wrapped)({ projectDir, distDir })).rejects.toThrow("user hook said no");
    expect(readFileSync(chunk, "utf8")).toBe("export const secret = 1;");
  });
});
