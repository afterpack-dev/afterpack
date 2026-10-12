import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __reset, __setProcessResult, engineCalls } from "../../../test/core-fake.js";
import { findAngularBrowserDir } from "./browser-dir.js";
import { afterpackAngular } from "./index.js";

let root: string;
let browserDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "afterpack-angular-test-"));
  writeFileSync(join(root, "package.json"), "{}");
  browserDir = join(root, "dist", "angular-fixture", "browser");
  mkdirSync(browserDir, { recursive: true });
  writeFileSync(join(root, ".gitignore"), "");
  __reset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  __setProcessResult((input) => ({ code: `OBF:${input}`, sourceMap: null, protectionMap: null }));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("findAngularBrowserDir", () => {
  it("locates the modern dist/<app>/browser output", () => {
    expect(findAngularBrowserDir(join(root, "dist"))).toBe(browserDir);
  });

  it("errors when multiple nested browser dirs exist", () => {
    mkdirSync(join(root, "dist", "second-app", "browser"), { recursive: true });
    expect(() => findAngularBrowserDir(join(root, "dist"))).toThrow(/multiple/);
  });

  it("falls back to a direct dist/browser dir", () => {
    const flat = mkdtempSync(join(tmpdir(), "afterpack-angular-flat-"));
    mkdirSync(join(flat, "dist", "browser"), { recursive: true });
    expect(findAngularBrowserDir(join(flat, "dist"))).toBe(join(flat, "dist", "browser"));
    rmSync(flat, { recursive: true, force: true });
  });

  it("errors clearly when no browser output can be found", () => {
    const empty = mkdtempSync(join(tmpdir(), "afterpack-angular-empty-"));
    mkdirSync(join(empty, "dist"));
    expect(() => findAngularBrowserDir(join(empty, "dist"))).toThrow(/could not locate/);
    rmSync(empty, { recursive: true, force: true });
  });
});

describe("afterpackAngular", () => {
  it("obfuscates the located browser bundle in place, defaulting backup off so original source never ships in the public bundle", async () => {
    writeFileSync(join(browserDir, "main-ABC123.js"), "export const a = 1;");
    writeFileSync(join(browserDir, "polyfills-XYZ.js"), "export const b = 2;");
    writeFileSync(join(browserDir, "styles-Q.css"), ".x{}");

    await afterpackAngular({ cwd: root });

    expect(readFileSync(join(browserDir, "main-ABC123.js"), "utf8")).toContain(
      "OBF:export const a = 1;",
    );
    expect(readFileSync(join(browserDir, "polyfills-XYZ.js"), "utf8")).toContain(
      "OBF:export const b = 2;",
    );
    expect(readFileSync(join(browserDir, "styles-Q.css"), "utf8")).toBe(".x{}");
    expect(readdirSync(browserDir).some((f) => /\.backup\./.test(f))).toBe(false);
    expect(engineCalls.map((c) => c.input).sort()).toEqual([
      "export const a = 1;",
      "export const b = 2;",
    ]);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("");
  });

  it("writes the protection receipt to .afterpack/receipts/, never into the served browser dir", async () => {
    writeFileSync(join(browserDir, "main.js"), "export const a = 1;");
    writeFileSync(join(browserDir, ".afterpack-protection.json"), "{}");

    await afterpackAngular({ cwd: root });

    const receiptPath = join(
      root,
      ".afterpack",
      "receipts",
      "dist%2Fangular-fixture%2Fbrowser.json",
    );
    expect(existsSync(receiptPath)).toBe(true);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    expect(receipt.files.map((f: { path: string }) => f.path)).toEqual(["main.js"]);
    expect(readdirSync(browserDir)).toEqual(["main.js"]);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("");
  });

  it("writes .afterpack/.gitignore when a Protection Map lands there, and never touches the project's own .gitignore", async () => {
    writeFileSync(join(browserDir, "main.js"), "export const a = 1;");
    __setProcessResult((input) => ({
      code: `OBF:${input}`,
      sourceMap: null,
      protectionMap: { schemaVersion: 4, files: [] },
    }));

    await afterpackAngular({ cwd: root, protectionMap: { enabled: true } });

    expect(readFileSync(join(root, ".afterpack", ".gitignore"), "utf8")).toBe("*\n");
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("");
  });

  it("honors an explicit browserDir (skips auto-location)", async () => {
    const custom = join(root, "custom-out");
    mkdirSync(custom, { recursive: true });
    writeFileSync(join(custom, "app.js"), "export const c = 3;");
    await afterpackAngular({ cwd: root, browserDir: custom });
    expect(readFileSync(join(custom, "app.js"), "utf8")).toContain("OBF:export const c = 3;");
    expect(engineCalls.map((c) => c.input)).toEqual(["export const c = 3;"]);
  });

  it("fails closed (rejects) when the engine reports an error", async () => {
    __setProcessResult(() => ({
      code: "",
      sourceMap: null,
      protectionMap: null,
      diagnostics: [{ severity: "error", message: "boom", code: "DIAG_X" }],
    }));
    writeFileSync(join(browserDir, "main.js"), "eval('x');");
    await expect(afterpackAngular({ cwd: root })).rejects.toThrow(/failed to obfuscate/);
  });
});

describe("afterpackAngular afterpack.json", () => {
  it("reaches the engine when the front door was given no options but `cwd`", async () => {
    writeFileSync(join(root, "afterpack.json"), JSON.stringify({ preset: "hard" }));
    writeFileSync(join(browserDir, "main.js"), "export const a = 1;");

    await afterpackAngular({ cwd: root });

    expect(engineCalls[0].config.preset).toBe("hard");
  });

  it("is outranked by the options object", async () => {
    writeFileSync(join(root, "afterpack.json"), JSON.stringify({ preset: "hard" }));
    writeFileSync(join(browserDir, "main.js"), "export const a = 1;");

    await afterpackAngular({ cwd: root, preset: "medium" });

    expect(engineCalls[0].config.preset).toBe("medium");
  });

  it("fails the run on an unknown key instead of silently dropping it", async () => {
    writeFileSync(join(root, "afterpack.json"), JSON.stringify({ level: "medium" }));
    writeFileSync(join(browserDir, "main.js"), "export const a = 1;");
    await expect(afterpackAngular({ cwd: root })).rejects.toThrow(
      /unknown configuration key `level`/,
    );
  });
});

describe("afterpackAngular refuses `directives.enabled`", () => {
  function write(): void {
    writeFileSync(join(browserDir, "main.js"), "export const a = 1;");
  }

  it("fails the build when the options object sets it, naming the reason", async () => {
    write();
    await expect(
      // @ts-expect-error `directives` is Omitted from this front door's options on purpose.
      afterpackAngular({ cwd: root, directives: { enabled: true } }),
    ).rejects.toThrow(
      /`directives\.enabled` is not supported here — the Angular application builder is sealed/,
    );
  });

  it("fails the build when afterpack.json sets it, not just the options object", async () => {
    write();
    writeFileSync(join(root, "afterpack.json"), JSON.stringify({ directives: { enabled: true } }));
    await expect(afterpackAngular({ cwd: root })).rejects.toThrow(
      /`directives\.enabled` is not supported here/,
    );
  });

  it("allows an explicit `false`, so one shared afterpack.json can name the key", async () => {
    write();
    writeFileSync(join(root, "afterpack.json"), JSON.stringify({ directives: { enabled: false } }));
    await expect(afterpackAngular({ cwd: root })).resolves.toBeUndefined();
  });

  it("still runs normally when nobody sets it", async () => {
    write();
    await afterpackAngular({ cwd: root });
    expect(engineCalls).toHaveLength(1);
  });
});

const BUNDLER_MAP = JSON.stringify({
  version: 3,
  sources: ["src/secret.ts"],
  sourcesContent: ["export const secret: string = 'ORIGINAL';"],
  mappings: "AAAA",
});
const CSS_MAP = JSON.stringify({ version: 3, sources: ["src/app.css"], mappings: "AAAA" });
const ENGINE_MAP = JSON.stringify({
  version: 3,
  sources: ["src/secret.ts"],
  sourcesContent: ["export const secret: string = 'ORIGINAL';"],
  mappings: "AAAA",
  names: ["engine"],
});

function writeBundlerMappedOutput(dir: string): void {
  mkdirSync(join(dir, "maps"), { recursive: true });
  writeFileSync(join(dir, "external.js"), "var e=1;\n//# sourceMappingURL=external.js.map\n");
  writeFileSync(join(dir, "external.js.map"), BUNDLER_MAP);
  const inline = Buffer.from(BUNDLER_MAP).toString("base64");
  writeFileSync(
    join(dir, "inline.js"),
    `var i=1;\n//# sourceMappingURL=data:application/json;base64,${inline}\n`,
  );
  writeFileSync(join(dir, "renamed.js"), "var r=1;\n//# sourceMappingURL=maps/renamed.map\n");
  writeFileSync(join(dir, "maps", "renamed.map"), BUNDLER_MAP);
  writeFileSync(join(dir, "maps", "stale-chunk.js.map"), BUNDLER_MAP);
  writeFileSync(join(dir, "styles.css"), "a{}\n/*# sourceMappingURL=styles.css.map*/");
  writeFileSync(join(dir, "styles.css.map"), CSS_MAP);
}

function mapsUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".map"))
    .map((name) => name.replaceAll("\\", "/"))
    .sort();
}

function bundlerSourceLeftIn(dir: string): string[] {
  const inline = Buffer.from(BUNDLER_MAP).toString("base64");
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((name) => {
    if (!/\.(?:js|map)$/.test(name)) return false;
    const text = readFileSync(join(dir, name), "utf8");
    return text === BUNDLER_MAP || text.includes(inline);
  });
}

function trailersIn(dir: string, names: string[]): string[] {
  return names.filter((name) => readFileSync(join(dir, name), "utf8").includes("sourceMappingURL"));
}

const OUTPUTS = ["external.js", "inline.js", "renamed.js", "styles.css"];
const ENGINE_MAPS = ["external.js.map", "inline.js.map", "renamed.js.map"];

describe("afterpackAngular never ships the Angular builder's own source map", () => {
  it("deletes external, hidden and CSS maps and strips inline ones by default", async () => {
    writeBundlerMappedOutput(browserDir);

    await afterpackAngular({ cwd: root });

    expect(mapsUnder(browserDir)).toEqual([]);
    expect(bundlerSourceLeftIn(browserDir)).toEqual([]);
    expect(trailersIn(browserDir, OUTPUTS)).toEqual([]);
  });

  it("ships the engine's maps, never the builder's, when sourceMap.enabled opts in", async () => {
    writeBundlerMappedOutput(browserDir);
    __setProcessResult((input) => ({ code: `OBF:${input}`, sourceMap: ENGINE_MAP }));

    await afterpackAngular({ cwd: root, sourceMap: { enabled: true } });

    expect(mapsUnder(browserDir)).toEqual([...ENGINE_MAPS, "styles.css.map"]);
    for (const map of ENGINE_MAPS) {
      expect(readFileSync(join(browserDir, map), "utf8")).toBe(ENGINE_MAP);
    }
    expect(bundlerSourceLeftIn(browserDir)).toEqual([]);
  });
});
