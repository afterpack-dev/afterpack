import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCliOptions } from "./config-parse.js";
import {
  type AfterpackPluginOptions,
  normalizePluginOptions,
  type PluginConfigInput,
  resolvePluginConfig,
} from "./plugin-config.js";
import { getPath, validateConfig } from "./registry.js";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "afterpack-plugin-config-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function writeConfigFile(config: unknown): void {
  writeFileSync(join(cwd, "afterpack.json"), JSON.stringify(config));
}

describe("resolvePluginConfig — the three places", () => {
  it("reads afterpack.json when the plugin was given no options at all", () => {
    writeConfigFile({ preset: "hard", identifiers: { rename: false } });
    const resolved = resolvePluginConfig({ label: "afterpack-vite", cwd, env: {} });
    expect(resolved.options.preset).toBe("hard");
    expect(resolved.engineConfig.identifiers?.rename).toBe(false);
    expect(resolved.configFile).toBe(join(cwd, "afterpack.json"));
  });

  it("finds the config file at an ANCESTOR of the working directory", () => {
    writeConfigFile({ preset: "medium" });
    const nested = join(cwd, "apps", "web");
    mkdirSync(nested, { recursive: true });
    const resolved = resolvePluginConfig({ label: "afterpack-vite", cwd: nested, env: {} });
    expect(resolved.options.preset).toBe("medium");
  });

  it("ranks the environment above the file", () => {
    writeConfigFile({ preset: "light" });
    const resolved = resolvePluginConfig({
      label: "afterpack-vite",
      cwd,
      env: { AFTERPACK_preset: "medium" },
    });
    expect(resolved.options.preset).toBe("medium");
  });

  it("ranks the plugin options object above both (R9)", () => {
    writeConfigFile({ preset: "light" });
    const resolved = resolvePluginConfig({
      label: "afterpack-vite",
      cwd,
      env: { AFTERPACK_preset: "medium" },
      options: { preset: "extreme" },
    });
    expect(resolved.options.preset).toBe("extreme");
  });

  it("merges the three places key by key rather than letting one win outright", () => {
    writeConfigFile({ preset: "hard", protectionMap: { detailed: false } });
    const resolved = resolvePluginConfig({
      label: "afterpack-vite",
      cwd,
      env: { AFTERPACK_seed: "git" },
      options: { build: { backup: true } },
    });
    expect(resolved.options.preset).toBe("hard");
    expect(resolved.options.seed).toBe("git");
    expect(resolved.options.artifactOptions.build?.backup).toBe(true);
    expect(resolved.engineConfig.protectionMap?.detailed).toBe(false);
    expect(resolved.config).toEqual({
      preset: "hard",
      protectionMap: { detailed: false },
      seed: "git",
      build: { backup: true },
    });
  });

  it("returns a null configFile and an empty config when nothing is set anywhere", () => {
    const resolved = resolvePluginConfig({ label: "afterpack-vite", cwd, env: {} });
    expect(resolved.configFile).toBeNull();
    expect(resolved.engineConfig).toEqual({});
    expect(resolved.options.preset).toBeUndefined();
  });
});

describe("resolvePluginConfig — a boolean on a group means its `.enabled`", () => {
  it("routes protectionMap and sourceMap to their `.enabled` keys", () => {
    const resolved = resolvePluginConfig({
      label: "afterpack-vite",
      cwd,
      env: {},
      options: { protectionMap: true, sourceMap: false, complexity: 40 },
    });
    expect(resolved.engineConfig.protectionMap?.enabled).toBe(true);
    expect(resolved.engineConfig.sourceMap?.enabled).toBe(false);
    expect(resolved.engineConfig.complexity).toBe(40);
    expect(resolved.options.artifactOptions.protectionMap?.enabled).toBe(true);
    expect(resolved.options.complexity).toBe(40);
  });

  it("leaves the boolean for validateConfig to route, and keeps a sibling of the group", () => {
    const { config, issues } = normalizePluginOptions(
      { sourceMap: true, protectionMap: { detailed: false } },
      [],
      "options",
    );
    expect(issues).toEqual([]);
    expect(config).toEqual({ sourceMap: true, protectionMap: { detailed: false } });
    expect(validateConfig(config, "options").config).toEqual({
      sourceMap: { enabled: true },
      protectionMap: { detailed: false },
    });
  });

  it("a config-file value the plugin option overrides resolves to the option", () => {
    writeConfigFile({ complexity: 2 });
    const resolved = resolvePluginConfig({
      label: "afterpack-vite",
      cwd,
      env: {},
      options: { complexity: 80 },
    });
    expect(resolved.options.complexity).toBe(80);
  });
});

describe("`key` is refused on the plugin-options surface only", () => {
  it("refuses it in a plugin options object, naming AFTERPACK_KEY", () => {
    let message = "";
    try {
      resolvePluginConfig({
        label: "afterpack-vite",
        cwd,
        env: {},
        options: { key: "ap_live_secret" },
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("`key` is not a plugin option");
    expect(message).toContain("AFTERPACK_KEY");
    expect(message).toContain("afterpack.json");
    expect(message).not.toContain("ap_live_secret");
  });

  it("accepts it in afterpack.json, which is where the engine reads it", () => {
    writeConfigFile({ key: "ap_live_file" });
    const resolved = resolvePluginConfig({ label: "afterpack-vite", cwd, env: {} });
    expect(resolved.options.key).toBe("ap_live_file");
  });

  it("accepts it in the environment", () => {
    const resolved = resolvePluginConfig({
      label: "afterpack-vite",
      cwd,
      env: { AFTERPACK_key: "ap_live_env" },
    });
    expect(resolved.options.key).toBe("ap_live_env");
  });

  it("accepts it on the command line, the registry surface it is defined on", () => {
    expect(getPath(parseCliOptions(["--key=ap_live_cli"]).config, "key")).toBe("ap_live_cli");
  });

  it("is not on the plugin options TYPE either, so the compiler refuses it first", () => {
    // @ts-expect-error `key` is omitted from AfterpackPluginOptions
    const withKey: AfterpackPluginOptions = { key: "ap_live_typed" };
    expect(withKey).toBeDefined();
  });
});

describe("resolvePluginConfig — plugin-local options", () => {
  it("passes declared local names through instead of rejecting them", () => {
    expect(() =>
      resolvePluginConfig({
        label: "afterpack-vite",
        cwd,
        env: {},
        options: { leg: "main", scope: "bundle", projectRoot: "/tmp/app", preset: "hard" },
        localKeys: ["leg", "scope", "projectRoot"],
      }),
    ).not.toThrow();
  });

  it("keeps `git` out of the schema on every front door without declaring it", () => {
    expect(() =>
      resolvePluginConfig({
        label: "afterpack-rollup",
        cwd,
        env: {},
        options: { git: false },
      }),
    ).not.toThrow();
  });

  it("still rejects a name no plugin declared", () => {
    expect(() =>
      resolvePluginConfig({ label: "afterpack-vite", cwd, env: {}, options: { leg: "main" } }),
    ).toThrow(/unknown configuration key `leg`/);
  });
});

describe("resolvePluginConfig — fail-closed, with provenance", () => {
  it("names the config file path when the bad value came from it", () => {
    writeConfigFile({ preset: "hardened" });
    expect(() => resolvePluginConfig({ label: "afterpack-vite", cwd, env: {} })).toThrow(
      new RegExp(`${join(cwd, "afterpack.json").replace(/[\\/]/g, "\\$&")}: .*\`preset\``),
    );
  });

  it("names the environment when the bad value came from a variable", () => {
    expect(() =>
      resolvePluginConfig({
        label: "afterpack-vite",
        cwd,
        env: { AFTERPACK_complexity: "-1" },
      }),
    ).toThrow(/environment: `complexity`/);
  });

  it("names the options object when the bad value came from the plugin call", () => {
    expect(() =>
      resolvePluginConfig({
        label: "afterpack-webpack",
        cwd,
        env: {},
        options: { preset: "turbo" },
      }),
    ).toThrow(/the afterpack-webpack options object: `preset`/);
  });

  it("leads with the plugin's own label so a multi-plugin build says which one refused", () => {
    expect(() =>
      resolvePluginConfig({ label: "afterpack-esbuild", cwd, env: {}, options: { level: 3 } }),
    ).toThrow(/^\[afterpack-esbuild\] refusing to build with an invalid configuration:/);
  });

  it("reports EVERY rejection, across all three places, in one refusal", () => {
    writeConfigFile({ nope: 1 });
    let message = "";
    try {
      resolvePluginConfig({
        label: "afterpack-vite",
        cwd,
        env: { AFTERPACK_alsoNope: "1" },
        options: { stillNope: true },
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("`nope`");
    expect(message).toContain("`alsoNope`");
    expect(message).toContain("`stillNope`");
  });

  it("rejects a kebab-cased option name rather than dropping it", () => {
    expect(() =>
      resolvePluginConfig({
        label: "afterpack-vite",
        cwd,
        env: {},
        options: { "protection-map": true },
      }),
    ).toThrow(/protection-map/);
  });

  it("refuses a non-object options value", () => {
    expect(() =>
      resolvePluginConfig({ label: "afterpack-vite", cwd, env: {}, options: "hard" }),
    ).toThrow(/must be an object/);
  });

  it("refuses invalid JSON in afterpack.json", () => {
    writeFileSync(join(cwd, "afterpack.json"), "{ oops");
    expect(() => resolvePluginConfig({ label: "afterpack-vite", cwd, env: {} })).toThrow(
      /is not valid JSON/,
    );
  });
});

describe("resolvePluginConfig — keys a front door cannot honour", () => {
  const unsupported = { directives: "this pass only sees minified output" };

  it("refuses the key on the options object, naming the reason", () => {
    expect(() =>
      resolvePluginConfig({
        label: "afterpack-angular",
        cwd,
        env: {},
        options: { directives: true },
        unsupported,
      }),
    ).toThrow(/`directives` is not supported here — this pass only sees minified output/);
  });

  it("refuses it from the environment too, so no layer is a silent bypass", () => {
    expect(() =>
      resolvePluginConfig({
        label: "afterpack-angular",
        cwd,
        env: { AFTERPACK_directives: "true" },
        unsupported,
      }),
    ).toThrow(/environment: `directives` is not supported here/);
  });

  it("refuses it from afterpack.json too", () => {
    writeConfigFile({ directives: true });
    expect(() =>
      resolvePluginConfig({ label: "afterpack-angular", cwd, env: {}, unsupported }),
    ).toThrow(/afterpack\.json: `directives` is not supported here/);
  });

  it("allows an explicit `false` from any layer — that asks for what it already does", () => {
    writeConfigFile({ directives: false });
    expect(() =>
      resolvePluginConfig({
        label: "afterpack-angular",
        cwd,
        env: { AFTERPACK_directives: "false" },
        options: { directives: false },
        unsupported: { directives: "the postbuild runs over a sealed builder" },
      }),
    ).not.toThrow();
  });

  it("refuses a non-empty LIST key, naming the layer that set it", () => {
    writeConfigFile({ paths: { include: ["**/node_modules/**"] } });
    expect(() =>
      resolvePluginConfig({
        label: "afterpack-vite",
        cwd,
        env: {},
        unsupported: { "paths.include": "this plugin does no on-disk walk" },
      }),
    ).toThrow(/afterpack\.json: `paths\.include` is not supported here/);
  });

  it("allows an EMPTY list — for a list key that is the same statement as `false`", () => {
    writeConfigFile({ paths: { include: [] } });
    expect(() =>
      resolvePluginConfig({
        label: "afterpack-vite",
        cwd,
        env: {},
        unsupported: { "paths.include": "this plugin does no on-disk walk" },
      }),
    ).not.toThrow();
  });

  it("stays silent about keys the front door DOES support", () => {
    writeConfigFile({ preset: "hard" });
    const resolved = resolvePluginConfig({ label: "afterpack-angular", cwd, env: {}, unsupported });
    expect(resolved.options.preset).toBe("hard");
  });
});

describe("resolvePluginConfig — the ONE directives default", () => {
  it("resolves to the registry default when nobody set it", () => {
    const resolved = resolvePluginConfig({ label: "afterpack-vite", cwd, env: {} });
    expect(resolved.options.directives).toBe(true);
    expect(resolved.options.directivesExplicit).toBe(false);
  });

  it("marks it explicit when the user set it, in any layer", () => {
    writeConfigFile({ directives: false });
    const resolved = resolvePluginConfig({ label: "afterpack-vite", cwd, env: {} });
    expect(resolved.options.directives).toBe(false);
    expect(resolved.options.directivesExplicit).toBe(true);
  });
});

describe("resolvePluginConfig — precedence, most specific wins", () => {
  it("ranks a flag and an options-object entry EQUALLY, both above the environment", () => {
    writeConfigFile({ preset: "minify", seed: 1 });

    const both = resolvePluginConfig({
      label: "afterpack-vite",
      cwd,
      argv: ["--preset=hard"],
      options: { complexity: 40 },
      env: { AFTERPACK_preset: "medium", AFTERPACK_complexity: "2" },
    });
    expect(getPath(both.config, "preset")).toBe("hard");
    expect(getPath(both.config, "complexity")).toBe(40);

    expect(() =>
      resolvePluginConfig({
        label: "afterpack-vite",
        cwd,
        env: {},
        argv: ["--preset=hard"],
        options: { preset: "light" },
      }),
    ).toThrow(/set twice at the same precedence/);

    expect(() =>
      resolvePluginConfig({
        label: "afterpack-vite",
        cwd,
        env: {},
        argv: ["--preset=hard"],
        options: { preset: "hard" },
      }),
    ).not.toThrow();
  });

  it("ranks a flag and an options object over the environment over the file", () => {
    writeConfigFile({ preset: "minify" });
    const presetFor = (input: Partial<PluginConfigInput>): unknown =>
      getPath(
        resolvePluginConfig({ label: "afterpack-next", cwd, env: {}, ...input }).config,
        "preset",
      );

    expect(presetFor({})).toBe("minify");
    expect(presetFor({ env: { AFTERPACK_preset: "medium" } })).toBe("medium");
    expect(presetFor({ env: { AFTERPACK_preset: "medium" }, options: { preset: "light" } })).toBe(
      "light",
    );
    expect(presetFor({ env: { AFTERPACK_preset: "medium" }, argv: ["--preset=hard"] })).toBe(
      "hard",
    );
  });
});

describe("resolvePluginConfig — argv", () => {
  it("returns positionals and the parsed flags", () => {
    const resolved = resolvePluginConfig({
      label: "afterpack",
      cwd,
      env: {},
      argv: ["dist", "--preset=hard"],
    });
    expect(resolved.positionals).toEqual(["dist"]);
    expect(resolved.options.preset).toBe("hard");
    expect(resolved.help).toBe(false);
  });

  it("answers --help/--version BEFORE any layer can refuse, with an empty config", () => {
    writeConfigFile({ preset: "hardened" });
    const help = resolvePluginConfig({ label: "afterpack", cwd, env: {}, argv: ["--help"] });
    expect(help.help).toBe(true);
    expect(help.config).toEqual({});
    expect(help.engineConfig).toEqual({});

    const ver = resolvePluginConfig({ label: "afterpack", cwd, env: {}, argv: ["--version"] });
    expect(ver.version).toBe(true);
  });

  it("names the command line as the surface that carried a bad flag", () => {
    expect(() =>
      resolvePluginConfig({ label: "afterpack", cwd, env: {}, argv: ["--level=medium"] }),
    ).toThrow(/command line: unknown configuration key `level`/);
  });
});
