import { parseCliOptions, validateConfig } from "@afterpack/integration-utils";
import { describe, expect, it } from "vitest";
import { expandShortFlags, HELP, HELP_ALL, renderFlag, toRunOptions, USAGE } from "../src/args.js";

function runOptionsFor(argv: string[]) {
  const parsed = parseCliOptions(argv);
  expect(parsed.issues).toEqual([]);
  return { options: toRunOptions(parsed.config), positionals: parsed.positionals };
}

describe("toRunOptions", () => {
  it("leaves every artifact option unset for a bare target", () => {
    const { options, positionals } = runOptionsFor(["dist"]);
    expect(positionals).toEqual(["dist"]);
    expect(options.pathsInclude).toEqual([]);
    expect(options.engineConfig).toEqual({});
    expect(Object.values(options.artifactOptions).every((v) => v === undefined)).toBe(true);
  });

  it("maps the artifact keys onto the policy's option object, at their registry paths", () => {
    const { options } = runOptionsFor([
      "dist",
      "--protectionMap.enabled=false",
      "--build.backup=false",
      "--sourceMap.enabled=false",
      "--telemetry.enabled=false",
    ]);
    expect(options.artifactOptions).toMatchObject({
      protectionMap: { enabled: false },
      build: { backup: false },
      sourceMap: { enabled: false },
      telemetry: { enabled: false },
    });
  });

  it("takes a bare group name as that group's `.enabled`", () => {
    const { options } = runOptionsFor(["dist", "--protectionMap=false", "--telemetry=false"]);
    expect(options.artifactOptions).toMatchObject({
      protectionMap: { enabled: false },
      telemetry: { enabled: false },
    });
  });

  it("keeps the preset bundle and the numeric target separate", () => {
    expect(runOptionsFor(["dist", "--preset=hard"]).options).toMatchObject({
      preset: "hard",
      complexity: undefined,
    });
    expect(runOptionsFor(["dist", "--complexity=12"]).options).toMatchObject({
      preset: undefined,
      complexity: 12,
    });
    expect(runOptionsFor(["dist", "--preset=hard", "--complexity=40"]).options).toMatchObject({
      preset: "hard",
      complexity: 40,
    });
  });

  it("coerces a numeric seed to a number and leaves `git` a string", () => {
    expect(runOptionsFor(["dist", "--seed=42"]).options.seed).toBe(42);
    expect(runOptionsFor(["dist", "--seed=git"]).options.seed).toBe("git");
  });

  it("forwards the engine-schema keys and nothing else", () => {
    const { options } = runOptionsFor([
      "dist",
      "--paths.exclude=vendor/**,*.min.js",
      "--identifiers.rename=false",
      "--telemetry.enabled=false",
      "--paths.include=**/node_modules/**",
    ]);
    expect(options.engineConfig).toEqual({
      paths: { exclude: ["vendor/**", "*.min.js"] },
      identifiers: { rename: false },
    });
    expect(options.pathsInclude).toEqual(["**/node_modules/**"]);
  });
});

describe("the flags the CLI no longer has", () => {
  it.each([
    ["--no-protection-map"],
    ["--no-backup"],
    ["--no-source-map"],
    ["--include-node-modules"],
    ["--includeNodeModules"],
    ["-p"],
    ["-c"],
    ["--level=medium"],
  ])("rejects %s instead of ignoring it", (flag) => {
    const parsed = parseCliOptions(["dist", flag]);
    expect(parsed.issues.length).toBeGreaterThan(0);
  });

  it("names the canonical form for a kebab-cased flag", () => {
    const parsed = parseCliOptions(["dist", "--no-backup"]);
    expect(parsed.issues[0].message).toContain("kebab-case");
  });

  it("names the removed space-separated form and never re-reads its value as a path", () => {
    const parsed = parseCliOptions(["dist", "--preset", "hard"]);
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0].message).toContain("the space-separated form was removed");
    expect(parsed.issues[0].message).toContain("`--preset=hard`");
    expect(parsed.positionals).toEqual(["dist"]);
  });

  it("names it for the one-token form too, and still reports a bad value", () => {
    const one = parseCliOptions(["dist", "--preset hard"]);
    expect(one.issues).toHaveLength(1);
    expect(one.issues[0].message).toContain("write `--preset=hard`");

    const bad = parseCliOptions(["dist", "--preset", "nope"]);
    expect(bad.issues.map((i) => i.message).join("\n")).toContain("one of:");
  });

  it("leaves a boolean key's bare form alone: the next token is still the path", () => {
    const parsed = parseCliOptions(["--build.backup", "dist"]);
    expect(parsed.issues).toEqual([]);
    expect(parsed.positionals).toEqual(["dist"]);
  });

  it("points --strings=on at the keys it is a group of", () => {
    const parsed = parseCliOptions(["dist", "--strings=on"]);
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0].message).toContain("is a group of configuration keys");
    expect(parsed.issues[0].message).toContain("`strings.encode`");
  });

  it("points a preset name written on --complexity at --preset", () => {
    const parsed = parseCliOptions(["dist", "--complexity=hard"]);
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0].message).toContain("expected a number >= 0");
    expect(parsed.issues[0].message).toContain("write `--preset=hard`");
  });
});

describe("help", () => {
  it("shows the one-spelling usage line in both the short and the full help", () => {
    expect(USAGE).toContain("--key=value");
    expect(HELP).toContain(USAGE);
    expect(HELP_ALL).toContain(USAGE);
  });

  it("the short help lists only the common options, each with its default", () => {
    expect(HELP).toContain("--preset=<minify|light|medium|hard|extreme>");
    expect(HELP).toContain("default: light");
    expect(HELP).not.toContain("--identifiers.reserved=<name[,...]>");
    expect(HELP).not.toContain("regions (afterpack.json only)");
  });

  it("the full help lists every registry key with its default", () => {
    expect(HELP_ALL).toContain("--preset=<minify|light|medium|hard|extreme>");
    expect(HELP_ALL).toContain("--identifiers.reserved=<name[,...]>");
    expect(HELP_ALL).toContain("regions (afterpack.json only)");
    expect(HELP_ALL).toContain("default: light");
  });

  it("documents the bundled-build reasoning for paths.include in the full help", () => {
    expect(HELP_ALL).toContain("--paths.include=<string[,...]>");
    expect(HELP_ALL).toContain("--paths.include='**/node_modules/**'");
    expect(HELP_ALL).toContain("node_modules path left to match");
  });

  it("renders a structured key as file-only", () => {
    expect(
      renderFlag({
        path: "regions",
        shape: "structured",
        scope: "program",
        tier: "pro",
        surface: "engine",
        item: { kind: "region" },
        default: "[]",
      }),
    ).toBe("regions (afterpack.json only)");
  });
});

describe("the two short flags the CLI expands for itself", () => {
  it.each([["-h"], ["-v"]])("%s is not a flag to the shared parser", (flag) => {
    expect(parseCliOptions(["dist", flag]).issues.length).toBeGreaterThan(0);
  });

  it("becomes the long form before parsing", () => {
    expect(expandShortFlags(["-h", "dist", "-v", "-p"])).toEqual([
      "--help",
      "dist",
      "--version",
      "-p",
    ]);
  });
});

describe("plugin options go through the same validator", () => {
  it("rejects a key the registry does not define", () => {
    expect(validateConfig({ hardened: true }, "plugin options").issues).toHaveLength(1);
  });
});
