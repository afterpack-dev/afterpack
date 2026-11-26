import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCliOptions, parseEnvOptions } from "./config-parse.js";
import { resolvePluginConfig, settleConfigLayers } from "./plugin-config.js";
import { CONFIG_RESET, getPath, validateConfig } from "./registry.js";
import { resetBuildSessions, resolveBuildSeed } from "./seed.js";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "afterpack-empty-values-"));
  resetBuildSessions();
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  resetBuildSessions();
});

function writeConfigFile(config: unknown): void {
  writeFileSync(join(cwd, "afterpack.json"), JSON.stringify(config));
}

function resolve(input: {
  env?: Record<string, string | undefined>;
  argv?: string[];
  options?: Record<string, unknown>;
}) {
  return resolvePluginConfig({
    label: "afterpack-vite",
    cwd,
    env: input.env ?? {},
    argv: input.argv,
    options: input.options,
  });
}

function refusal(input: Parameters<typeof resolve>[0]): string {
  try {
    resolve(input);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the configuration to be refused");
}

describe("an empty `key` resets to no key, over every lower layer", () => {
  it("AFTERPACK_KEY= overrides the key in afterpack.json", () => {
    writeConfigFile({ key: "ap_live_file" });
    expect(resolve({ env: { AFTERPACK_KEY: "" } }).options.key).toBeNull();
  });

  it("a whitespace-only AFTERPACK_KEY is empty too", () => {
    writeConfigFile({ key: "ap_live_file" });
    expect(resolve({ env: { AFTERPACK_KEY: "  \t" } }).options.key).toBeNull();
  });

  it("the case-kept AFTERPACK_key= resets it the same way", () => {
    writeConfigFile({ key: "ap_live_file" });
    expect(resolve({ env: { AFTERPACK_key: "" } }).options.key).toBeNull();
  });

  it("--key= overrides the environment", () => {
    expect(resolve({ env: { AFTERPACK_KEY: "ap_live_env" }, argv: ["--key="] }).options.key).toBe(
      null,
    );
  });

  it('`"key": "  "` in afterpack.json is no key', () => {
    writeConfigFile({ key: "  " });
    expect(resolve({}).options.key).toBeNull();
  });

  it("resolves to null when nothing sets a key, and trims one that is set", () => {
    expect(resolve({}).options.key).toBeNull();
    writeConfigFile({ key: "  ap_live_file " });
    expect(resolve({}).options.key).toBe("ap_live_file");
  });

  it("never writes the resolved key into the environment it read", () => {
    writeConfigFile({ key: "ap_live_file" });
    const env: Record<string, string | undefined> = {};
    const before = process.env.AFTERPACK_KEY;
    resolve({ env });
    expect(env).toEqual({});
    expect(process.env.AFTERPACK_KEY).toBe(before);
  });
});

describe("an empty `seed` resets to no pinned seed, over every lower layer", () => {
  it("AFTERPACK_SEED= overrides the seed in afterpack.json", () => {
    writeConfigFile({ seed: 42 });
    const resolved = resolve({ env: { AFTERPACK_SEED: "" } });
    expect(resolved.options.seed).toBeUndefined();
    expect(resolved.engineConfig.seed).toBeUndefined();
  });

  it("an empty seed in the options object overrides AFTERPACK_SEED", () => {
    expect(resolve({ env: { AFTERPACK_SEED: "7" }, options: { seed: "" } }).options.seed).toBe(
      undefined,
    );
  });

  it("--seed= overrides the environment", () => {
    expect(resolve({ env: { AFTERPACK_SEED: "7" }, argv: ["--seed="] }).options.seed).toBe(
      undefined,
    );
  });

  it('`"seed": ""` in afterpack.json is no pinned seed, not a constant one', () => {
    writeConfigFile({ seed: "" });
    expect(resolve({}).options.seed).toBeUndefined();
  });

  it("a reset seed draws a fresh seed instead of reading the variable again", () => {
    const resolved = resolve({ env: { AFTERPACK_SEED: "7" }, options: { seed: " " } });
    const seed = resolveBuildSeed(
      resolved.options.seed,
      { root: cwd, leg: "dist" },
      {
        env: { AFTERPACK_SEED: "7" },
        fallback: resolved.options.seedFallback,
        randomSeed: () => 99,
        exportToEnv: false,
      },
    );
    expect(seed).toMatchObject({ seed: 99, origin: "fresh" });
  });
});

describe("an empty list resets it to the empty list, over every lower layer", () => {
  it("AFTERPACK_STRINGS_PRESERVE_LITERALS= overrides the list in afterpack.json", () => {
    writeConfigFile({ strings: { preserveLiterals: ["KEEP"] } });
    const resolved = resolve({ env: { AFTERPACK_STRINGS_PRESERVE_LITERALS: "" } });
    expect(resolved.engineConfig.strings?.preserveLiterals).toEqual([]);
  });

  it("--paths.exclude= overrides the environment", () => {
    const resolved = resolve({
      env: { AFTERPACK_PATHS_EXCLUDE: "a/**" },
      argv: ["--paths.exclude="],
    });
    expect(resolved.engineConfig.paths?.exclude).toEqual([]);
  });

  it('`"paths": { "exclude": "" }` in afterpack.json is the empty list', () => {
    writeConfigFile({ paths: { exclude: " " } });
    expect(resolve({}).engineConfig.paths?.exclude).toEqual([]);
  });
});

describe("an empty enum, number or boolean is an error, naming what the user wrote", () => {
  it.each([
    ["AFTERPACK_PRESET", "preset"],
    ["AFTERPACK_COMPLEXITY", "complexity"],
    ["AFTERPACK_IDENTIFIERS_RENAME", "identifiers.rename"],
    ["AFTERPACK_INFLATION_MAX", "inflation.max"],
    ["AFTERPACK_preset", "preset"],
  ])("%s=", (name, path) => {
    const message = refusal({ env: { [name]: "" } });
    expect(message).toContain(`\`${path}\` is empty in \`${name}\``);
    expect(message).toContain("environment");
  });

  it("refuses a whitespace-only value the same way", () => {
    expect(refusal({ env: { AFTERPACK_PRESET: "   " } })).toContain(
      "`preset` is empty in `AFTERPACK_PRESET`",
    );
  });

  it("refuses --preset= on the command line", () => {
    const message = refusal({ argv: ["--preset="] });
    expect(message).toContain("`preset` is empty in `--preset=` (command line)");
    expect(message).toContain("minify, light, medium, hard, extreme");
  });

  it("refuses an empty number in afterpack.json, naming the field", () => {
    writeConfigFile({ complexity: "" });
    expect(refusal({})).toContain('`complexity` is empty in `"complexity": ""`');
  });

  it("refuses an empty boolean in the options object, naming the field", () => {
    const message = refusal({ options: { strings: { encode: "" } } });
    expect(message).toContain('`strings.encode` is empty in `"strings.encode": ""`');
    expect(message).toContain("the afterpack-vite options object");
  });

  it("never lets a blank CI substitution weaken a preset set lower down", () => {
    writeConfigFile({ preset: "hard" });
    expect(() => resolve({ env: { AFTERPACK_PRESET: "" } })).toThrow(/`preset` is empty/);
  });
});

describe("an empty group name is refused", () => {
  it.each([
    ["AFTERPACK_STRINGS", "strings"],
    ["AFTERPACK_SOURCE_MAP", "sourceMap"],
  ])("%s=", (name, group) => {
    const { issues } = parseEnvOptions({ [name]: "" });
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain(`\`${name}\` is empty and names the group \`${group}\``);
    expect(issues[0].message).toMatch(new RegExp(`\`${name}_[A-Z_]+\``));
  });

  it("refuses an empty group flag on the command line", () => {
    const { issues } = parseCliOptions(["--strings="]);
    expect(issues[0].message).toContain("`--strings=` is empty and names the group `strings`");
  });

  it("still ignores an empty variable that is not configuration at all", () => {
    expect(parseEnvOptions({ AFTERPACK_API_URL: "", AFTERPACK_E2E_BROWSERS: "" })).toEqual({
      config: {},
      issues: [],
    });
  });
});

describe("the reset marker", () => {
  it("is what parsing produces for an empty key or seed, on every surface", () => {
    expect(getPath(parseEnvOptions({ AFTERPACK_SEED: "" }).config, "seed")).toBe(CONFIG_RESET);
    expect(getPath(parseCliOptions(["--key="]).config, "key")).toBe(CONFIG_RESET);
    expect(getPath(validateConfig({ seed: " " }, "afterpack.json").config, "seed")).toBe(
      CONFIG_RESET,
    );
  });

  it("never reaches the merged configuration", () => {
    writeConfigFile({ seed: 1, key: "ap_live_file" });
    const resolved = resolve({ env: { AFTERPACK_SEED: "", AFTERPACK_KEY: "" } });
    expect(resolved.config).toEqual({});
  });
});

describe('seed "git" with no HEAD falls back through the lower layers in order', () => {
  const layers = (env: unknown, file: unknown) =>
    settleConfigLayers([
      {
        config: (file === undefined ? {} : { seed: file }) as never,
        from: "afterpack.json",
        seedOrigin: "option",
      },
      {
        config: (env === undefined ? {} : { seed: env }) as never,
        from: "the environment",
        seedOrigin: "env",
      },
      { config: { seed: "git" }, from: "the command line", seedOrigin: "option" },
    ]).options.seedFallback;

  it("takes the environment's seed first", () => {
    expect(layers(7, 3)).toEqual({ seed: 7, origin: "env", from: "the environment" });
  });

  it("then the afterpack.json seed", () => {
    expect(layers(undefined, 3)).toEqual({ seed: 3, origin: "option", from: "afterpack.json" });
  });

  it('skips a lower layer that also says "git"', () => {
    expect(layers("git", 3)).toEqual({ seed: 3, origin: "option", from: "afterpack.json" });
  });

  it("stops at a reset: an empty seed below means no pinned seed", () => {
    expect(layers(CONFIG_RESET, 3)).toBeNull();
  });

  it("has nothing to fall back to when the winning seed is not git", () => {
    const settled = settleConfigLayers([
      { config: { seed: 3 }, from: "afterpack.json", seedOrigin: "option" },
      { config: { seed: 5 }, from: "the environment", seedOrigin: "env" },
    ]);
    expect(settled.options.seed).toBe(5);
    expect(settled.options.seedFallback).toBeNull();
  });

  it("resolvePluginConfig hands the afterpack.json seed down when only the file pins one", () => {
    writeConfigFile({ seed: 3 });
    const resolved = resolve({ options: { seed: "git" } });
    expect(resolved.options.seed).toBe("git");
    expect(resolved.options.seedFallback).toEqual({
      seed: 3,
      origin: "option",
      from: join(cwd, "afterpack.json"),
    });
  });

  it("uses the fallback and says so when there is no HEAD", () => {
    const warnings: string[] = [];
    const seed = resolveBuildSeed(
      "git",
      { root: cwd, leg: "dist" },
      {
        gitHead: () => null,
        env: {},
        warn: (m) => warnings.push(m),
        fallback: { seed: 7, origin: "env", from: "the environment" },
      },
    );
    expect(seed).toMatchObject({ seed: 7, origin: "env" });
    expect(warnings).toEqual([
      '[afterpack] seed "git": no git repository / HEAD found; falling back to the seed 7 from the environment.',
    ]);
  });

  it("draws a fresh seed when no lower layer pins one", () => {
    const seed = resolveBuildSeed(
      "git",
      { root: cwd, leg: "dist" },
      {
        gitHead: () => null,
        env: { AFTERPACK_SEED: "7" },
        warn: () => {},
        fallback: null,
        randomSeed: () => 11,
        exportToEnv: false,
      },
    );
    expect(seed).toMatchObject({ seed: 11, origin: "fresh" });
  });
});

describe("a caller that resolved no layers still reads AFTERPACK_SEED", () => {
  it("treats a whitespace-only AFTERPACK_SEED as unset", () => {
    const seed = resolveBuildSeed(
      undefined,
      { root: cwd, leg: "dist" },
      { env: { AFTERPACK_SEED: "  " }, randomSeed: () => 5, exportToEnv: false },
    );
    expect(seed).toMatchObject({ seed: 5, origin: "fresh" });
  });
});
