import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AfterpackConfig,
  CONFIG_KEYS,
  type ConfigKeyDef,
  getPath,
  mergeConfig,
} from "@afterpack/integration-utils";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { __reset, __setProcessResult, engineCalls, processBatch } from "../../../test/core-fake.js";
import {
  configSample,
  nest,
  unforwardedBuildKeys,
} from "../../integration-utils/src/config-probe.js";
import { runAfterpackHook } from "./hook.js";
import type { AfterpackNextOptions } from "./index.js";

const ENGINE_KEYS = CONFIG_KEYS.filter((k) => k.surface === "engine") as ConfigKeyDef[];
const ENV_COMPATIBLE_ENGINE_KEYS = ENGINE_KEYS.filter((k) => k.shape !== "structured");

type Layer = "afterpack.json" | "environment" | "options object";

const roots: string[] = [];
const engine = { processBatch };
const BASE_ENV: NodeJS.ProcessEnv = { AFTERPACK_telemetry_enabled: "false" };

function everyKeyNested(keys: readonly ConfigKeyDef[]): AfterpackConfig {
  let out = {} as AfterpackConfig;
  for (const key of keys) {
    const sample = configSample(key);
    if (sample) out = mergeConfig(out, nest(key.path, sample.value) as AfterpackConfig);
  }
  return out;
}

function project(): { projectDir: string; distDir: string } {
  const projectDir = mkdtempSync(join(tmpdir(), "afterpack-next-front-door-"));
  roots.push(projectDir);
  const distDir = join(projectDir, ".next");
  mkdirSync(join(distDir, "static", "chunks"), { recursive: true });
  writeFileSync(join(distDir, "static", "chunks", "app.js"), "export const a = 1;");
  __reset();
  __setProcessResult((input) => ({ code: `OBF:${input}`, sourceMap: null, protectionMap: null }));
  return { projectDir, distDir };
}

async function crossedFrom(layer: Layer): Promise<Record<string, unknown>> {
  const metadata = project();
  const keys = layer === "environment" ? ENV_COMPATIBLE_ENGINE_KEYS : ENGINE_KEYS;
  const env: NodeJS.ProcessEnv = { ...BASE_ENV };
  let options: AfterpackConfig = {} as AfterpackConfig;
  if (layer === "afterpack.json") {
    writeFileSync(
      join(metadata.projectDir, "afterpack.json"),
      JSON.stringify(everyKeyNested(keys)),
    );
  } else if (layer === "environment") {
    for (const key of keys) {
      env[`AFTERPACK_${key.path.replace(/\./g, "_")}`] = configSample(key)?.flat;
    }
  } else {
    options = everyKeyNested(keys);
  }

  await runAfterpackHook({ metadata, options, engine, env });
  return JSON.parse(engineCalls[0].configJson) as Record<string, unknown>;
}

const crossed: Partial<Record<Layer, Record<string, unknown>>> = {};

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  for (const layer of ["afterpack.json", "environment", "options object"] as const) {
    crossed[layer] = await crossedFrom(layer);
  }
});
afterAll(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.each([
  ["afterpack.json", ENGINE_KEYS],
  ["environment", ENV_COMPATIBLE_ENGINE_KEYS],
  ["options object", ENGINE_KEYS],
] as const)("every engine key set in the %s reaches the engine", (layer, keys) => {
  it.each(keys.map((k) => [k.path] as const))("%s", (path) => {
    expect(
      getPath(crossed[layer] as AfterpackConfig, path),
      `\`${path}\` was accepted from the ${layer} and never reached the engine — ` +
        "the hook is resolving configuration somewhere this guard cannot see",
    ).toBeDefined();
  });
});

describe("the build-layer view comes from that same resolution", () => {
  it("acts on a build-surface key set in the options object", async () => {
    const metadata = project();
    await runAfterpackHook({
      metadata,
      options: { build: { autorun: false } },
      engine,
      env: BASE_ENV,
    });
    expect(engineCalls).toHaveLength(0);
  });

  it("lets the options object override that build key when the environment says otherwise", async () => {
    const metadata = project();
    await runAfterpackHook({
      metadata,
      options: { build: { autorun: true } },
      engine,
      env: { ...BASE_ENV, AFTERPACK_build_autorun: "false" },
    });
    expect(engineCalls).toHaveLength(1);
  });
});

describe("an invalid configuration FAILS the build", () => {
  it("refuses an unknown key in the options object rather than dropping it", async () => {
    const metadata = project();
    const typo = { level: "medium" } as Record<string, unknown> as AfterpackNextOptions;
    await expect(
      runAfterpackHook({ metadata, options: typo, engine, env: BASE_ENV }),
    ).rejects.toThrow(/unknown configuration key .level./);
    expect(engineCalls).toHaveLength(0);
  });
});

function captured(stream: "log" | "warn"): { lines: string[] } {
  const lines: string[] = [];
  vi.spyOn(console, stream).mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return { lines };
}

const BUILD_PROBES: Record<string, () => Promise<void>> = {
  "paths.include": async () => {
    const metadata = project();
    const nested = join(metadata.distDir, "static", "chunks", "node_modules", "dep");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "x.js"), "export const dep = 1;");

    await runAfterpackHook({ metadata, options: {}, engine, env: BASE_ENV });
    expect(engineCalls).toHaveLength(1);

    writeFileSync(join(metadata.distDir, "static", "chunks", "app.js"), "export const a = 1;");
    __reset();
    __setProcessResult((input) => ({ code: `OBF:${input}`, sourceMap: null, protectionMap: null }));
    await runAfterpackHook({
      metadata,
      options: { paths: { include: ["**/node_modules/**"] } },
      engine,
      env: BASE_ENV,
    });
    expect(engineCalls).toHaveLength(2);
  },

  "build.autorun": async () => {
    const metadata = project();
    await runAfterpackHook({
      metadata,
      options: { build: { autorun: false } },
      engine,
      env: BASE_ENV,
    });
    expect(engineCalls).toHaveLength(0);
  },

  directives: async () => {
    const off = captured("warn");
    await runAfterpackHook({
      metadata: project(),
      options: { directives: false },
      engine,
      env: BASE_ENV,
    });
    expect(off.lines.join("\n")).not.toContain("productionBrowserSourceMaps");

    const on = captured("warn");
    await runAfterpackHook({
      metadata: project(),
      options: { directives: true },
      engine,
      env: BASE_ENV,
    });
    expect(on.lines.join("\n")).toContain("productionBrowserSourceMaps");
  },

  "diagnostics.level": async () => {
    const freshProjectWithInfoDiagnostic = (): { projectDir: string; distDir: string } => {
      const metadata = project();
      __setProcessResult((input) => ({
        code: `OBF:${input}`,
        sourceMap: null,
        protectionMap: null,
        diagnostics: [{ severity: "info", message: "PROBE_INFO_BODY", code: "DIAG_PROBE" }],
      }));
      return metadata;
    };

    const quietMetadata = freshProjectWithInfoDiagnostic();
    const quiet = captured("log");
    await runAfterpackHook({ metadata: quietMetadata, options: {}, engine, env: BASE_ENV });
    expect(quiet.lines.join("\n")).not.toContain("PROBE_INFO_BODY");

    const loudMetadata = freshProjectWithInfoDiagnostic();
    const loud = captured("log");
    await runAfterpackHook({
      metadata: loudMetadata,
      options: { diagnostics: { level: "all" } },
      engine,
      env: BASE_ENV,
    });
    expect(loud.lines.join("\n")).toContain("PROBE_INFO_BODY");
  },

  key: async () => {
    const metadata = project();
    const env: NodeJS.ProcessEnv = { ...BASE_ENV, AFTERPACK_key: "ap_live_probe" };
    await runAfterpackHook({ metadata, options: {}, engine, env });
    expect(env.AFTERPACK_KEY).toBe("ap_live_probe");
  },
};

describe("every build-surface key this front door must forward itself is observable", () => {
  it.each(unforwardedBuildKeys().map((k) => [k.path] as const))("%s", async (path) => {
    const probe = BUILD_PROBES[path];
    expect(
      probe,
      `\`${path}\` is a build-surface key that does not ride artifactOptions, so this front ` +
        "door has to forward or refuse it itself. Add a probe to BUILD_PROBES that OBSERVES " +
        "it doing so — an unprobed key is exactly how three of them shipped accepted-and-dropped",
    ).toBeDefined();
    await probe();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
});
