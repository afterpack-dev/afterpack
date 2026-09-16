import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AfterpackConfig,
  CONFIG_KEYS,
  type ConfigKeyDef,
  getPath,
  mergeConfig,
} from "@afterpack/integration-utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { __reset, __setProcessResult, engineCalls, processBatch } from "../../../test/core-fake.js";
import {
  configSample,
  nest,
  unforwardedBuildKeys,
} from "../../integration-utils/src/config-probe.js";
import { run } from "../src/run.js";

const ENGINE_KEYS = CONFIG_KEYS.filter((k) => k.surface === "engine") as ConfigKeyDef[];
const FLAT_KEYS = ENGINE_KEYS.filter((k) => k.shape !== "structured");

type Layer = "afterpack.json" | "environment" | "flag";

const roots: string[] = [];
const silent = { log: () => {}, error: () => {}, warn: () => {} };

function everyKeyNested(keys: readonly ConfigKeyDef[]): AfterpackConfig {
  let out = {} as AfterpackConfig;
  for (const key of keys) {
    const sample = configSample(key);
    if (sample) out = mergeConfig(out, nest(key.path, sample.value) as AfterpackConfig);
  }
  return out;
}

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "afterpack-cli-front-door-"));
  roots.push(root);
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist", "app.js"), "export const a = 1;");
  __reset();
  __setProcessResult((input) => ({ code: `OBF:${input}`, sourceMap: null, protectionMap: null }));
  return root;
}

async function crossedFrom(layer: Layer): Promise<Record<string, unknown>> {
  const root = project();
  const keys = layer === "afterpack.json" ? ENGINE_KEYS : FLAT_KEYS;
  const argv = ["dist", "--telemetry.enabled=false"];
  const env: Record<string, string | undefined> = {};
  if (layer === "afterpack.json") {
    writeFileSync(join(root, "afterpack.json"), JSON.stringify(everyKeyNested(keys)));
  } else if (layer === "environment") {
    for (const key of keys) {
      env[`AFTERPACK_${key.path.replace(/\./g, "_")}`] = configSample(key)?.flat;
    }
  } else {
    for (const key of keys) argv.push(`--${key.path}=${configSample(key)?.flat}`);
  }

  const errors: string[] = [];
  const code = await run({
    argv,
    cwd: root,
    engine: { processBatch },
    logger: { ...silent, error: (m) => errors.push(m) },
    version: "9.9.9",
    env,
  });
  expect(errors.join("\n")).toBe("");
  expect(code).toBe(0);
  return JSON.parse(engineCalls[0].configJson) as Record<string, unknown>;
}

const crossed: Partial<Record<Layer, Record<string, unknown>>> = {};

beforeAll(async () => {
  for (const layer of ["afterpack.json", "environment", "flag"] as const) {
    crossed[layer] = await crossedFrom(layer);
  }
});
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.each([
  ["afterpack.json", ENGINE_KEYS],
  ["environment", FLAT_KEYS],
  ["flag", FLAT_KEYS],
] as const)("every engine key set in the %s reaches the engine", (layer, keys) => {
  it.each(keys.map((k) => [k.path] as const))("%s", (path) => {
    expect(
      getPath(crossed[layer] as AfterpackConfig, path),
      `\`${path}\` was accepted from the ${layer} and never reached the engine — ` +
        "the CLI is resolving configuration somewhere this guard cannot see",
    ).toBeDefined();
  });
});

interface Invocation {
  argv: string[];
  env: Record<string, string | undefined>;
}

describe("a key the CLI cannot honour is refused from every layer", () => {
  const layers: [string, (root: string) => Invocation][] = [
    ["flag", () => ({ argv: ["dist", "--directives"], env: {} })],
    ["environment", () => ({ argv: ["dist"], env: { AFTERPACK_directives: "true" } })],
    [
      "afterpack.json",
      (root) => {
        writeFileSync(join(root, "afterpack.json"), JSON.stringify({ directives: true }));
        return { argv: ["dist"], env: {} };
      },
    ],
  ];

  it.each(layers)("%s", async (_layer, setup) => {
    const root = project();
    const { argv, env } = setup(root);
    const errors: string[] = [];
    const code = await run({
      argv,
      cwd: root,
      engine: { processBatch },
      logger: { ...silent, error: (m) => errors.push(m) },
      version: "9.9.9",
      env,
    });
    expect(code).toBe(64);
    expect(errors.join("\n")).toContain("`directives` is not supported here");
    expect(engineCalls).toHaveLength(0);
  });
});

describe("the build-layer view comes from that same resolution", () => {
  it("acts on a build-surface key set in afterpack.json", async () => {
    const root = project();
    writeFileSync(
      join(root, "afterpack.json"),
      JSON.stringify({ build: { backup: true }, protectionMap: { enabled: false } }),
    );

    const code = await run({
      argv: ["dist", "--telemetry.enabled=false"],
      cwd: root,
      engine: { processBatch },
      logger: silent,
      version: "9.9.9",
      env: {},
    });

    expect(code).toBe(0);
    expect(
      readdirSync(join(root, "dist")).some((f) => /^app\.backup\.[0-9a-f]{8}\.js$/.test(f)),
    ).toBe(true);
  });
});

interface Ran {
  code: number;
  logs: string[];
  errors: string[];
  env: Record<string, string | undefined>;
}

async function runCli(root: string, argv: string[], env: Record<string, string | undefined> = {}) {
  const logs: string[] = [];
  const errors: string[] = [];
  const code = await run({
    argv,
    cwd: root,
    engine: { processBatch },
    logger: { log: (m) => logs.push(m), error: (m) => errors.push(m), warn: (m) => logs.push(m) },
    version: "9.9.9",
    env,
  });
  return { code, logs, errors, env } satisfies Ran;
}

const BUILD_PROBES: Record<string, () => Promise<void>> = {
  "paths.include": async () => {
    const projectWithVendoredDep = (): string => {
      const root = project();
      mkdirSync(join(root, "dist", "node_modules", "dep"), { recursive: true });
      writeFileSync(join(root, "dist", "node_modules", "dep", "x.js"), "export const dep = 1;");
      return root;
    };

    const without = await runCli(projectWithVendoredDep(), ["dist", "--telemetry.enabled=false"]);
    expect(without.code).toBe(0);
    expect(engineCalls).toHaveLength(1);

    const withGlob = await runCli(projectWithVendoredDep(), [
      "dist",
      "--telemetry.enabled=false",
      "--paths.include=**/node_modules/**",
    ]);
    expect(withGlob.code).toBe(0);
    expect(engineCalls).toHaveLength(2);
  },

  "build.autorun": async () => {
    const root = project();
    writeFileSync(join(root, "afterpack.json"), JSON.stringify({ build: { autorun: false } }));
    const ran = await runCli(root, ["dist", "--telemetry.enabled=false"]);
    expect(ran.code).toBe(0);
    expect(engineCalls).toHaveLength(0);
    expect(ran.logs.join("\n")).toContain("build.autorun is false");
  },

  directives: async () => {
    const root = project();
    const ran = await runCli(root, ["dist", "--directives"]);
    expect(ran.code).toBe(64);
    expect(ran.errors.join("\n")).toContain("`directives` is not supported here");
    expect(engineCalls).toHaveLength(0);
  },

  "diagnostics.level": async () => {
    const projectWhoseEngineReportsAnInfo = (): string => {
      const root = project();
      __setProcessResult((input) => ({
        code: `OBF:${input}`,
        sourceMap: null,
        protectionMap: null,
        diagnostics: [{ severity: "info", message: "PROBE_INFO_BODY", code: "DIAG_PROBE" }],
      }));
      return root;
    };

    const quiet = await runCli(projectWhoseEngineReportsAnInfo(), [
      "dist",
      "--telemetry.enabled=false",
    ]);
    expect(quiet.logs.join("\n")).not.toContain("PROBE_INFO_BODY");

    const loud = await runCli(projectWhoseEngineReportsAnInfo(), [
      "dist",
      "--telemetry.enabled=false",
      "--diagnostics.level=all",
    ]);
    expect(loud.logs.join("\n")).toContain("PROBE_INFO_BODY");

    const silent = await runCli(projectWhoseEngineReportsAnInfo(), [
      "dist",
      "--telemetry.enabled=false",
      "--diagnostics.level=none",
    ]);
    expect(silent.code).toBe(0);
    expect(silent.logs.join("\n")).not.toContain("Protected 1 file");
  },

  key: async () => {
    const root = project();
    const env: Record<string, string | undefined> = { AFTERPACK_key: "ap_live_probe" };
    const ran = await runCli(root, ["dist", "--telemetry.enabled=false"], env);
    expect(ran.code).toBe(0);
    expect(ran.env.AFTERPACK_KEY).toBe("ap_live_probe");
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
  });
});

const CLI_KEYS = CONFIG_KEYS.filter((k) => k.surface === "cli") as ConfigKeyDef[];

const CLI_PROBES: Record<string, () => Promise<void>> = {
  "diagnostics.format": async () => {
    const sample = "json";
    const observe = async (
      argv: string[],
      env: Record<string, string | undefined> = {},
    ): Promise<void> => {
      const ran = await runCli(project(), ["dist", "--telemetry.enabled=false", ...argv], env);
      expect(ran.code).toBe(0);
      expect(ran.logs.filter((l) => l.startsWith("{"))).toHaveLength(1);
      expect(JSON.parse(ran.logs.find((l) => l.startsWith("{")) as string)).toMatchObject({
        command: "obfuscate",
      });
    };

    await observe([`--diagnostics.format=${sample}`]);
    await observe([], { AFTERPACK_diagnostics_format: sample });

    const root = project();
    writeFileSync(
      join(root, "afterpack.json"),
      JSON.stringify({ diagnostics: { format: sample } }),
    );
    const fromFile = await runCli(root, ["dist", "--telemetry.enabled=false"]);
    expect(fromFile.code).toBe(0);
    expect(fromFile.logs.filter((l) => l.startsWith("{"))).toHaveLength(1);
  },
};

describe("every cli-surface key reaches this front door's own output", () => {
  it.each(CLI_KEYS.map((k) => [k.path] as const))("%s", async (path) => {
    const probe = CLI_PROBES[path];
    expect(
      probe,
      `\`${path}\` is a cli-surface key, so the CLI is the ONLY door that can honour it — ` +
        "and the only one that can prove it does. Add a probe to CLI_PROBES that OBSERVES " +
        "the output change, from a flag, a variable and afterpack.json alike",
    ).toBeDefined();
    await probe();
  });
});
