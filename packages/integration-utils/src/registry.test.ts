import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfigFile } from "./config-file.js";
import {
  ENV_PREFIX,
  LIVE_SCREAMING_ENV,
  parseCliOptions,
  parseEnvOptions,
} from "./config-parse.js";
import { configSample, nest } from "./config-probe.js";
import { resolvePluginConfig } from "./plugin-config.js";
import {
  type AfterpackConfig,
  CONFIG_KEYS,
  DIRECTIVES_ENABLED_DEFAULT,
  getPath,
  toEngineConfig,
  validateConfig,
} from "./registry.js";

const writable = CONFIG_KEYS.filter((k) => k.shape !== "structured");
const structured = CONFIG_KEYS.filter((k) => k.shape === "structured");

function envName(path: string): string {
  return `${ENV_PREFIX}${path.replace(/\./g, "_")}`;
}

function tempProject(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "afterpack-registry-"));
  for (const [name, contents] of Object.entries(files)) {
    const target = join(dir, name);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, contents);
  }
  return dir;
}

describe("the registry is the one definition", () => {
  it("gives every key a unique dotted camelCase path", () => {
    const seen = new Set<string>();
    for (const key of CONFIG_KEYS) {
      expect(seen.has(key.path), `duplicate ${key.path}`).toBe(false);
      seen.add(key.path);
      expect(key.path).toMatch(/^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)*$/);
    }
  });

  it("keeps the region-overridable set to the ratified keys", () => {
    const region = CONFIG_KEYS.filter((k) => k.scope === "region").map((k) => k.path);
    expect([...region].sort()).toEqual(["complexity", "inflation.max", "preset", "strings.encode"]);
  });
});

describe("every scalar and list key, through each place", () => {
  it.each(writable.map((k) => [k.path, k] as const))("%s", (path, key) => {
    const chosen = configSample(key);
    expect(chosen, `no sample value for ${path}`).toBeDefined();
    if (!chosen) return;

    const cli = parseCliOptions([`--${path}=${chosen.flat}`]);
    expect(cli.issues).toEqual([]);
    expect(getPath(cli.config, path)).toEqual(chosen.value);

    const env = parseEnvOptions({ [envName(path)]: chosen.flat as string });
    expect(env.issues).toEqual([]);
    expect(getPath(env.config, path)).toEqual(chosen.value);

    const nested = nest(path, chosen.value);
    const dir = tempProject({ "afterpack.json": JSON.stringify(nested) });
    const file = loadConfigFile(dir);
    expect(file.issues).toEqual([]);
    expect(getPath(file.config, path)).toEqual(chosen.value);
  });
});

describe("a structured key never rides a flag or a variable", () => {
  it.each(structured.map((k) => [k.path, k] as const))("%s", (path, key) => {
    const cli = parseCliOptions([`--${path}=x`]);
    expect(cli.issues).toHaveLength(1);
    expect(cli.issues[0].message).toContain("afterpack.json");
    expect(cli.issues[0].message).toContain(key.configFileForm ?? "");

    const env = parseEnvOptions({ [envName(path)]: "x" });
    expect(env.issues).toHaveLength(1);
    expect(env.issues[0].message).toContain("afterpack.json");
    expect(env.issues[0].message).toContain(key.configFileForm ?? "");
  });

  it("accepts the structured value in afterpack.json", () => {
    const dir = tempProject({
      "afterpack.json": JSON.stringify({ regions: [{ start: 0, end: 10, target: 40 }] }),
    });
    const file = loadConfigFile(dir);
    expect(file.issues).toEqual([]);
    expect(getPath(file.config, "regions")).toEqual([{ start: 0, end: 10, target: 40 }]);
  });
});

describe("a structured item is a CLOSED field set", () => {
  it("rejects a typo inside a region instead of running it at the global target", () => {
    const { config, issues } = validateConfig(
      { regions: [{ start: 0, end: 10, targt: 40 }] },
      "afterpack.json",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("unknown field `targt`");
    expect(issues[0].message).toContain("did you mean `target`?");
    expect(getPath(config, "regions")).toBeUndefined();
  });

  it("names every field a region item may carry", () => {
    expect(
      validateConfig({ regions: [{ start: 0, end: 1, nope: 1 }] }, "t").issues[0].message,
    ).toContain("allowed: start, end, target, max, floor, only, deny, label");
    expect(
      validateConfig(
        {
          regions: [
            {
              start: 0,
              end: 1,
              target: 4,
              max: 2,
              floor: true,
              only: ["scopeDeepen"],
              deny: ["integerBytecode"],
              label: "skip",
            },
          ],
        },
        "t",
      ).issues,
    ).toEqual([]);
  });

  it("type-checks each region field and requires start and end", () => {
    expect(
      validateConfig({ regions: [{ start: 0, end: 1, target: "hard" }] }, "t").issues[0],
    ).toMatchObject({ message: expect.stringContaining("`target` must be a number >= 0") });
    expect(
      validateConfig({ regions: [{ start: 0, end: 1, deny: ["nope"] }] }, "t").issues[0],
    ).toMatchObject({ message: expect.stringContaining("`deny` must be a list of:") });
    expect(validateConfig({ regions: [{ start: 0 }] }, "t").issues[0]).toMatchObject({
      message: expect.stringContaining("missing `end`"),
    });
  });

  it("closes the identifiers.reserved object item too", () => {
    const { issues } = validateConfig(
      { identifiers: { reserved: [{ glb: "src/**", names: ["jQuery"] }] } },
      "t",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("unknown field `glb`");
    expect(issues[0].message).toContain("did you mean `glob`?");
    expect(
      validateConfig({ identifiers: { reserved: [{ glob: "src/**" }] } }, "t").issues[0].message,
    ).toContain("missing `names`");
  });
});

describe("a mixedList", () => {
  it("takes comma-separated scalars on the command line and in the environment", () => {
    const cli = parseCliOptions(["--identifiers.reserved=Hls,gtag"]);
    expect(cli.issues).toEqual([]);
    expect(getPath(cli.config, "identifiers.reserved")).toEqual(["Hls", "gtag"]);

    const env = parseEnvOptions({ AFTERPACK_identifiers_reserved: "Hls,gtag" });
    expect(env.issues).toEqual([]);
    expect(getPath(env.config, "identifiers.reserved")).toEqual(["Hls", "gtag"]);
  });

  it("rejects a value containing `{` with the afterpack.json form, never partially applied", () => {
    for (const parsed of [
      parseCliOptions(['--identifiers.reserved=Hls,{"glob":"src/**","names":["jQuery"]}']),
      parseEnvOptions({
        AFTERPACK_identifiers_reserved: 'Hls,{"glob":"src/**","names":["jQuery"]}',
      }),
    ]) {
      expect(parsed.issues).toHaveLength(1);
      expect(parsed.issues[0].message).toContain(
        '{ "identifiers": { "reserved": [{ "glob": "…", "names": ["…"] }] } }',
      );
      expect(getPath(parsed.config, "identifiers.reserved")).toBeUndefined();
    }
  });

  it("forwards both item kinds to the engine on the one `reserved` key", () => {
    const config = validateConfig(
      { identifiers: { reserved: ["Hls", { glob: "src/legacy/**", names: ["jQuery"] }] } },
      "test",
    );
    expect(config.issues).toEqual([]);
    expect(toEngineConfig(config.config).identifiers).toEqual({
      reserved: ["Hls", { glob: "src/legacy/**", names: ["jQuery"] }],
    });
  });
});

describe("a list replaces its default, never extends it", () => {
  it("takes the most specific place's whole list", () => {
    const dir = tempProject({
      "afterpack.json": JSON.stringify({ paths: { exclude: ["a/**", "b/**"] } }),
    });
    const resolved = resolvePluginConfig({
      label: "afterpack",
      cwd: dir,
      env: {},
      argv: ["--paths.exclude=c/**"],
    });
    expect(getPath(resolved.config, "paths.exclude")).toEqual(["c/**"]);
  });
});

describe("inflation.max", () => {
  it('resolves "unlimited" from every place', () => {
    const dir = tempProject({ "afterpack.json": JSON.stringify({ inflation: { max: 2 } }) });
    expect(getPath(loadConfigFile(dir).config, "inflation.max")).toBe(2);

    const fromFile = tempProject({
      "afterpack.json": JSON.stringify({ inflation: { max: "unlimited" } }),
    });
    expect(getPath(loadConfigFile(fromFile).config, "inflation.max")).toBe("unlimited");
    expect(getPath(parseCliOptions(["--inflation.max=unlimited"]).config, "inflation.max")).toBe(
      "unlimited",
    );
    expect(
      getPath(parseEnvOptions({ AFTERPACK_inflation_max: "unlimited" }).config, "inflation.max"),
    ).toBe("unlimited");
  });

  it("rejects Infinity with a CTA naming unlimited", () => {
    for (const parsed of [
      parseCliOptions(["--inflation.max=Infinity"]),
      parseEnvOptions({ AFTERPACK_inflation_max: "Infinity" }),
      { issues: validateConfig({ inflation: { max: "Infinity" } }, "test").issues },
    ]) {
      expect(parsed.issues).toHaveLength(1);
      expect(parsed.issues[0].message).toContain('"unlimited"');
    }
  });
});

describe("parse errors", () => {
  it("rejects kebab-case with the canonical form", () => {
    const cli = parseCliOptions(["--strings.min-length=4"]);
    expect(cli.issues[0].message).toContain("kebab-case");
    expect(cli.issues[0].message).toContain("--strings.minLength");
  });

  it("rejects an unknown key rather than dropping it", () => {
    const cli = parseCliOptions(["--level=medium"]);
    expect(cli.issues).toHaveLength(1);
    expect(cli.issues[0].message).toContain("unknown configuration key `level`");
  });

  it("suggests the nearest key for a near miss", () => {
    expect(parseCliOptions(["--complexiti=4"]).issues[0].message).toContain(
      "did you mean `complexity`",
    );
  });

  it("tells a key that is a PREFIX of real keys it is a group, not a typo", () => {
    const one = parseCliOptions(["--reflection=x"]).issues[0].message;
    expect(one).toContain("`reflection` is a group of configuration keys, not a key itself");
    expect(one).toContain("did you mean `reflection.allow`?");

    const many = parseCliOptions(["--identifiers=x"]).issues[0].message;
    expect(many).toContain("its keys are");
    expect(many).toContain("`identifiers.rename`");
    expect(many).toContain("`identifiers.reserved`");
  });

  it("points a preset name written on complexity at preset, in every place", () => {
    expect(parseCliOptions(["--complexity=hard"]).issues[0].message).toContain(
      "write `--preset=hard`",
    );
    expect(parseEnvOptions({ AFTERPACK_complexity: "hard" }).issues[0].message).toContain(
      "write `AFTERPACK_preset=hard`",
    );
    expect(validateConfig({ complexity: "hard" }, "afterpack.json").issues[0].message).toContain(
      'write `"preset": "hard"`',
    );
  });

  it("names the removed space-separated form rather than an unknown key", () => {
    const one = parseCliOptions(["--preset hard"]).issues[0].message;
    expect(one).toContain("the space-separated form was removed");
    expect(one).toContain("write `--preset=hard`");
    expect(one).not.toContain("unknown configuration key");
  });

  it("rejects a JSON array literal where a list is comma-separated", () => {
    for (const parsed of [
      parseCliOptions(['--identifiers.reserved=["a","b"]']),
      parseEnvOptions({ AFTERPACK_identifiers_reserved: '["a","b"]' }),
    ]) {
      expect(parsed.issues).toHaveLength(1);
      expect(parsed.issues[0].message).toContain("not a JSON array");
      expect(getPath(parsed.config, "identifiers.reserved")).toBeUndefined();
    }
    expect(parseCliOptions(["--paths.exclude=[]"]).issues[0].message).toContain(
      "write `--paths.exclude=` for an empty list",
    );
  });

  it("rejects a short flag", () => {
    expect(parseCliOptions(["-p", "hard"]).issues[0].message).toContain("no short flags");
  });

  it("reads a bare boolean key as true and `=false` as false", () => {
    expect(getPath(parseCliOptions(["--build.backup"]).config, "build.backup")).toBe(true);
    expect(getPath(parseCliOptions(["--build.backup=false"]).config, "build.backup")).toBe(false);
  });

  it("rejects a bare non-boolean key", () => {
    expect(parseCliOptions(["--preset"]).issues[0].message).toContain("one of:");
  });

  it("treats a JSON literal as that literal and anything else as a string", () => {
    expect(getPath(parseCliOptions(['--preset="hard"']).config, "preset")).toBe("hard");
    expect(getPath(parseCliOptions(["--preset=hard"]).config, "preset")).toBe("hard");
    expect(getPath(parseCliOptions(["--complexity=40"]).config, "complexity")).toBe(40);
  });
});

describe("the environment mapper", () => {
  it("maps underscores to dots and preserves case", () => {
    const env = parseEnvOptions({ AFTERPACK_strings_minLength: "12" });
    expect(env.issues).toEqual([]);
    expect(getPath(env.config, "strings.minLength")).toBe(12);
  });

  it("leaves the non-configuration AFTERPACK_ variables alone", () => {
    const env = parseEnvOptions({
      AFTERPACK_NOT_A_KEY: "1",
      AFTERPACK_ALSO_NOT_A_KEY: "1",
      AFTERPACK_API_URL: "http://localhost",
      AFTERPACK_ROOT: "/tmp",
      AFTERPACK_STILL_NOT_A_KEY: "x",
      AFTERPACK_REALLY_NOT_A_KEY: "1",
      AFTERPACK_DEFINITELY_NOT_A_KEY: "1",
    });
    expect(env.issues).toEqual([]);
    expect(env.config).toEqual({});
  });

  it("keeps the SCREAMING twins that still have a live reader working and silent", () => {
    expect([...LIVE_SCREAMING_ENV].sort()).toEqual(["KEY", "SEED"]);
    const env = parseEnvOptions({ AFTERPACK_SEED: "9", AFTERPACK_KEY: "ap_live_x" });
    expect(env.issues).toEqual([]);
    expect(env.config).toEqual({});
  });

  it("rejects a lower-case variable that names no key, pointing at the one it meant", () => {
    const issues = parseEnvOptions({ AFTERPACK_autorun: "0" }).issues;
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("unknown configuration key `autorun`");
    expect(issues[0].message).toContain("did you mean `build.autorun`?");
  });

  it("rejects an all-caps variable that names a real key, pointing at its lower-case twin", () => {
    expect(parseEnvOptions({ AFTERPACK_PRESET: "hard" }).issues[0].message).toContain(
      "write `AFTERPACK_preset`",
    );
    expect(parseEnvOptions({ AFTERPACK_TELEMETRY: "0" }).issues[0].message).toContain(
      "write `AFTERPACK_telemetry_enabled`",
    );
    expect(parseEnvOptions({ AFTERPACK_COMPLEXITY: "40" }).issues[0].message).toContain(
      "write `AFTERPACK_complexity`",
    );
    expect(parseEnvOptions({ AFTERPACK_ALLOW_UNOBFUSCATED: "1" }).issues[0].message).toContain(
      "write `AFTERPACK_allowUnobfuscated`",
    );
    expect(parseEnvOptions({ AFTERPACK_IDENTIFIERS: "x" }).issues[0].message).toContain(
      "its keys are `AFTERPACK_identifiers_rename`",
    );
    expect(parseEnvOptions({ AFTERPACK_PRESET: "hard" }).config).toEqual({});
  });

  it("documents the directives.enabled default as a LITERAL that still matches the constant", () => {
    const key = CONFIG_KEYS.find((k) => k.path === "directives.enabled");
    expect(key?.default).toBe(String(DIRECTIVES_ENABLED_DEFAULT));
  });

  it("is loud on the SCREAMING twin of every registry key, never silent", () => {
    for (const key of CONFIG_KEYS) {
      const screaming = envName(key.path).toUpperCase();
      if (LIVE_SCREAMING_ENV.has(screaming.slice(ENV_PREFIX.length))) continue;
      const issues = parseEnvOptions({ [screaming]: "1" }).issues;
      expect(issues, `${screaming} was silently dropped`).toHaveLength(1);
      expect(issues[0].message).toContain("not a configuration variable");
      expect(issues[0].message).toContain(envName(key.path));
    }
  });
});

describe("afterpack.json", () => {
  it("is found at the nearest ancestor of the working directory", () => {
    const dir = tempProject({
      "afterpack.json": JSON.stringify({ preset: "medium" }),
      "packages/app/.keep": "",
    });
    const resolved = resolvePluginConfig({
      label: "afterpack",
      cwd: join(dir, "packages", "app"),
      env: {},
    });
    expect(resolved.configFile).toBe(join(dir, "afterpack.json"));
    expect(getPath(resolved.config, "preset")).toBe("medium");
  });

  it("rejects an unknown key in the file, naming the file", () => {
    const dir = tempProject({ "afterpack.json": JSON.stringify({ hardened: true }) });
    const loaded = loadConfigFile(dir);
    expect(loaded.issues).toHaveLength(1);
    expect(loaded.issues[0].message).toContain("unknown configuration key `hardened`");
    expect(loaded.issues[0].message).toContain(dir);
  });

  it("reports invalid JSON instead of silently defaulting", () => {
    const dir = tempProject({ "afterpack.json": "{ nope" });
    expect(loadConfigFile(dir).issues[0].message).toContain("is not valid JSON");
  });
});

describe("the engine subset", () => {
  it("forwards only engine keys, at their own paths", () => {
    const { config, issues } = validateConfig(
      {
        preset: "hard",
        complexity: 40,
        build: { backup: true },
        telemetry: { enabled: false },
        paths: { include: ["**/node_modules/**"], exclude: ["vendor/**"] },
        protectionMap: { enabled: false },
      },
      "test",
    );
    expect(issues).toEqual([]);
    expect(toEngineConfig(config)).toEqual({
      preset: "hard",
      complexity: 40,
      paths: { exclude: ["vendor/**"] },
      protectionMap: { enabled: false },
    });
  });
});

describe("the derived options type", () => {
  it("accepts a nested config and rejects what the registry does not define", () => {
    const ok: AfterpackConfig = {
      preset: "hard",
      complexity: 40,
      inflation: { max: "unlimited" },
      identifiers: { rename: true, reserved: ["Hls", { glob: "src/**", names: ["jQuery"] }] },
      transforms: {
        integerBytecode: { enabled: false },
        selfIntegrity: { enabled: true },
      },
      reflection: { allow: ["nameIntrospection"] },
      regions: [{ start: 0, end: 10, target: 4 }],
      seed: "git",
      diagnostics: { level: "all" },
    };
    expect(validateConfig(ok, "test").issues).toEqual([]);

    // @ts-expect-error unknown top-level key
    const unknownKey: AfterpackConfig = { nope: true };
    // @ts-expect-error value outside the enum
    const badEnum: AfterpackConfig = { preset: "hardish" };
    // @ts-expect-error scalar of the wrong type
    const badScalar: AfterpackConfig = { complexity: "40" };
    // @ts-expect-error unknown nested key
    const badNested: AfterpackConfig = { identifiers: { renam: true } };
    expect([unknownKey, badEnum, badScalar, badNested]).toHaveLength(4);
  });

  it("takes a boolean on a group with an `enabled` child, and only there", () => {
    const ok: AfterpackConfig = {
      protectionMap: false,
      sourceMap: true,
      telemetry: false,
      transforms: { scopeDeepen: false },
    };
    expect(validateConfig(ok, "test").issues).toEqual([]);

    // @ts-expect-error `identifiers` has no `enabled` child
    const noEnabled: AfterpackConfig = { identifiers: false };
    // @ts-expect-error the value grammar has no `on`/`off`
    const notBoolean: AfterpackConfig = { protectionMap: "on" };
    expect([noEnabled, notBoolean]).toHaveLength(2);
  });
});

describe("a comma-separated list", () => {
  it("rejects a stray comma rather than accepting an empty item", () => {
    const cli = parseCliOptions(["--paths.exclude=a/**,,b/**"]);
    expect(cli.issues).toHaveLength(1);
    expect(cli.issues[0].message).toContain("empty item");
    expect(getPath(cli.config, "paths.exclude")).toBeUndefined();
  });

  it("takes an explicit empty value as an empty list", () => {
    const cli = parseCliOptions(["--paths.exclude="]);
    expect(cli.issues).toEqual([]);
    expect(getPath(cli.config, "paths.exclude")).toEqual([]);
  });
});

describe("a boolean written on a group name", () => {
  const GROUPS_WITH_ENABLED = ["protectionMap", "sourceMap", "telemetry", "transforms.scopeDeepen"];

  it("means that group's `.enabled` in all four write-surfaces", () => {
    for (const group of GROUPS_WITH_ENABLED) {
      const enabled = `${group}.enabled`;
      const file = mkdtempSync(join(tmpdir(), "afterpack-group-bool-"));
      writeFileSync(
        join(file, "afterpack.json"),
        JSON.stringify(nest(group, false) as Record<string, unknown>),
      );
      expect(getPath(loadConfigFile(file).config, enabled)).toBe(false);

      expect(getPath(validateConfig(nest(group, false), "options").config, enabled)).toBe(false);
      expect(getPath(parseCliOptions([`--${group}=false`]).config, enabled)).toBe(false);
      expect(getPath(parseCliOptions([`--${group}`]).config, enabled)).toBe(true);
      const variable = `${ENV_PREFIX}${group.replace(/\./g, "_")}`;
      expect(getPath(parseEnvOptions({ [variable]: "false" }).config, enabled)).toBe(false);
    }
  });

  it("merges with a sibling of the same group rather than replacing it", () => {
    const { config, issues } = validateConfig(
      { protectionMap: { detailed: false }, sourceMap: true },
      "test",
    );
    expect(issues).toEqual([]);
    expect(config).toEqual({
      protectionMap: { detailed: false },
      sourceMap: { enabled: true },
    });
  });

  it("stays an error on a group with no `enabled` child", () => {
    for (const group of ["identifiers", "strings", "build", "paths", "diagnostics"]) {
      const message = parseCliOptions([`--${group}=false`]).issues[0]?.message ?? "";
      expect(message).toContain("is a group of configuration keys");
      expect(message).not.toContain("a boolean here means");
    }
  });

  it("names the rule when a group is given something that is not a boolean", () => {
    const message = parseCliOptions(["--protectionMap=on"]).issues[0].message;
    expect(message).toContain("is a group of configuration keys");
    expect(message).toContain("a boolean here means `protectionMap.enabled`");
  });
});
