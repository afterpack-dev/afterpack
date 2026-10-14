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
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __reset, __setProcessResult, __setVersion, engineCalls } from "../../../test/core-fake.js";
import { findAngularBrowserDir } from "./browser-dir.js";
import { afterpackAngular, angularHashToken } from "./index.js";
import {
  angularFileSourceTypes,
  angularSourceType,
  classifyAngularScripts,
} from "./source-type.js";

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

function writeAngularOutput(dir: string, extraBody = ""): void {
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html><html><body><app-root></app-root><link rel="modulepreload" href="chunk-SHARED01.js">` +
      `<script src="polyfills-POLY0001.js" type="module"></script>${extraBody}` +
      `<script src="main-MAIN0001.js" type="module"></script></body></html>`,
  );
  writeFileSync(join(dir, "polyfills-POLY0001.js"), "var ce=globalThis;ce.zone=1;");
  writeFileSync(
    join(dir, "main-MAIN0001.js"),
    'import{a as s}from"./chunk-SHARED01.js";' +
      'let w=new Worker(new URL("worker-WORK0001.js",import.meta.url),{type:"module"});' +
      'import("./chunk-LAZY0001.js").then(m=>m.run(s,w));',
  );
  writeFileSync(join(dir, "chunk-SHARED01.js"), "var a=1;export{a};");
  writeFileSync(
    join(dir, "chunk-LAZY0001.js"),
    'import"./chunk-DEEP0001.js";export function run(){}',
  );
  writeFileSync(join(dir, "chunk-DEEP0001.js"), "globalThis.deep=1;");
  writeFileSync(join(dir, "worker-WORK0001.js"), "addEventListener('message',()=>postMessage(1));");
}

function namesOf(paths: string[]): string[] {
  return paths.map((path) => path.slice(browserDir.length + 1));
}

function classify(): ReturnType<typeof classifyAngularScripts> {
  const files = readdirSync(browserDir, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".js"))
    .map((name) => join(browserDir, name));
  return classifyAngularScripts(browserDir, files);
}

describe("classifyAngularScripts", () => {
  it("follows the module graph from module scripts, modulepreload links, imports and module workers", () => {
    writeAngularOutput(browserDir);
    const kinds = classify();
    expect(namesOf(kinds.module)).toEqual([
      "chunk-DEEP0001.js",
      "chunk-LAZY0001.js",
      "chunk-SHARED01.js",
      "main-MAIN0001.js",
      "polyfills-POLY0001.js",
      "worker-WORK0001.js",
    ]);
    expect(kinds.classic).toEqual([]);
    expect(kinds.unclaimed).toEqual([]);
    expect(angularSourceType(kinds)).toBe("module");
  });

  it("names the global scripts bundle a classic script and withholds module from the mixed build", () => {
    writeAngularOutput(browserDir, '<script src="scripts-GLOB0001.js" defer></script>');
    writeFileSync(join(browserDir, "scripts-GLOB0001.js"), "var legacyGlobal=1;");
    const kinds = classify();
    expect(namesOf(kinds.classic)).toEqual(["scripts-GLOB0001.js"]);
    expect(kinds.module).toHaveLength(6);
    expect(angularSourceType(kinds)).toBeUndefined();
  });

  it("withholds module when a copied asset is loaded by nothing it can follow", () => {
    writeAngularOutput(browserDir);
    mkdirSync(join(browserDir, "vendor"));
    writeFileSync(join(browserDir, "vendor", "copied.js"), "var copied=1;");
    const kinds = classify();
    expect(namesOf(kinds.unclaimed)).toEqual([join("vendor", "copied.js")]);
    expect(angularSourceType(kinds)).toBeUndefined();
  });

  it("never counts a worker started without type module as a module", () => {
    writeAngularOutput(browserDir);
    writeFileSync(
      join(browserDir, "main-MAIN0001.js"),
      'import"./chunk-SHARED01.js";new Worker(new URL("worker-WORK0001.js",import.meta.url));',
    );
    rmSync(join(browserDir, "chunk-LAZY0001.js"));
    rmSync(join(browserDir, "chunk-DEEP0001.js"));
    const kinds = classify();
    expect(namesOf(kinds.unclaimed)).toEqual(["worker-WORK0001.js"]);
    expect(angularSourceType(kinds)).toBeUndefined();
  });

  it("maps each classified file, under the caller's own path spelling, to its sourceType", () => {
    writeAngularOutput(browserDir, '<script src="scripts-GLOB0001.js" defer></script>');
    writeFileSync(join(browserDir, "scripts-GLOB0001.js"), "var legacyGlobal=1;");
    mkdirSync(join(browserDir, "vendor"));
    writeFileSync(join(browserDir, "vendor", "copied.js"), "var copied=1;");
    const files = ["main-MAIN0001.js", "scripts-GLOB0001.js", join("vendor", "copied.js")].map(
      (name) => relative(process.cwd(), join(browserDir, name)),
    );
    const types = angularFileSourceTypes(classifyAngularScripts(browserDir, files), files);
    expect([...types]).toEqual([
      [files[0], "module"],
      [files[1], "script"],
    ]);
  });

  it("withholds module from output no HTML loads as a module", () => {
    writeFileSync(join(browserDir, "index.html"), '<script src="main.js"></script>');
    writeFileSync(join(browserDir, "main.js"), "var a=1;");
    const kinds = classify();
    expect(namesOf(kinds.classic)).toEqual(["main.js"]);
    expect(angularSourceType(kinds)).toBeUndefined();
  });
});

describe("afterpackAngular sourceType", () => {
  beforeEach(() => {
    __setVersion("0.2.3");
  });

  it("sends module for the application builder's ES module output", async () => {
    writeAngularOutput(browserDir);
    await afterpackAngular({ cwd: root });
    expect(engineCalls).toHaveLength(6);
    expect(engineCalls[0].config.sourceType).toBe("module");
  });

  it("withholds it when the build also ships a classic global scripts bundle", async () => {
    writeAngularOutput(browserDir, '<script src="scripts-GLOB0001.js" defer></script>');
    writeFileSync(join(browserDir, "scripts-GLOB0001.js"), "var legacyGlobal=1;");
    await afterpackAngular({ cwd: root });
    expect(engineCalls[0].config.sourceType).toBeUndefined();
  });

  it("withholds it on an engine too old to take the key", async () => {
    __setVersion("0.2.2");
    writeAngularOutput(browserDir);
    await afterpackAngular({ cwd: root });
    expect(engineCalls[0].config.sourceType).toBeUndefined();
  });
});

describe("afterpackAngular per-file sourceType", () => {
  const kindsSent = () =>
    Object.fromEntries(
      engineCalls.map((call) => [call.path.split("-")[0].split(".")[0], call.sourceType]),
    );

  function writeMixedOutput(): void {
    writeAngularOutput(browserDir, '<script src="scripts-GLOB0001.js" defer></script>');
    writeFileSync(join(browserDir, "scripts-GLOB0001.js"), "var legacyGlobal=1;");
  }

  it("sends each file's own sourceType for a build that mixes modules and classic scripts", async () => {
    __setVersion("0.2.5");
    writeMixedOutput();
    await afterpackAngular({ cwd: root });
    expect(kindsSent()).toEqual({
      chunk: "module",
      main: "module",
      polyfills: "module",
      scripts: "script",
      worker: "module",
    });
    expect(engineCalls).toHaveLength(7);
    expect(engineCalls.filter((c) => c.path.startsWith("chunk")).map((c) => c.sourceType)).toEqual([
      "module",
      "module",
      "module",
    ]);
    expect(engineCalls[0].config.sourceType).toBeUndefined();
  });

  it("sends module per file beside the build-level module for an all-module build", async () => {
    __setVersion("0.2.5");
    writeAngularOutput(browserDir);
    await afterpackAngular({ cwd: root });
    expect(engineCalls.map((c) => c.sourceType)).toEqual(Array(6).fill("module"));
    expect(engineCalls[0].config.sourceType).toBe("module");
  });

  it("leaves a file it cannot classify to the engine", async () => {
    __setVersion("0.2.5");
    writeAngularOutput(browserDir);
    mkdirSync(join(browserDir, "vendor"));
    writeFileSync(join(browserDir, "vendor", "copied.js"), "var copied=1;");
    await afterpackAngular({ cwd: root });
    const copied = engineCalls.find((c) => c.path === "vendor/copied.js");
    expect(copied).toBeDefined();
    expect(copied?.sourceType).toBeUndefined();
    expect(engineCalls.filter((c) => c.sourceType === "module")).toHaveLength(6);
    expect(engineCalls[0].config.sourceType).toBeUndefined();
  });

  it("sends no per-file sourceType on an engine older than 0.2.5", async () => {
    __setVersion("0.2.4");
    writeMixedOutput();
    await afterpackAngular({ cwd: root });
    expect(engineCalls).toHaveLength(7);
    expect(engineCalls.every((c) => c.sourceType === undefined)).toBe(true);
    expect(engineCalls[0].config.sourceType).toBeUndefined();
  });

  it("lets a configured sourceType decide for every file", async () => {
    __setVersion("0.2.5");
    writeMixedOutput();
    await afterpackAngular({ cwd: root, sourceType: "script" });
    expect(engineCalls.every((c) => c.sourceType === undefined)).toBe(true);
    expect(engineCalls[0].config.sourceType).toBe("script");
  });
});

describe("angularHashToken", () => {
  it.each([
    ["browser/main-M4BIKID7.js", "M4BIKID7"],
    ["browser/chunk-2VMXMS7J.js", "2VMXMS7J"],
    ["browser/styles-5INURTSO.css", "5INURTSO"],
    ["server/chunk-ABCD2345.mjs", "ABCD2345"],
    ["browser/main.js", null],
    ["browser/media/logo-ABCD2345.png", null],
  ])("reads esbuild's content hash from %s", (path, token) => {
    expect(angularHashToken(path)).toBe(token);
  });
});

describe("afterpackAngular content-hashed names", () => {
  function hashedOutput(): void {
    writeFileSync(
      join(browserDir, "index.html"),
      '<script src="polyfills-POLYAAAA.js" type="module"></script>' +
        '<script src="main-MAINAAAA.js" type="module"></script>',
    );
    writeFileSync(join(browserDir, "polyfills-POLYAAAA.js"), "var zone=1;");
    writeFileSync(join(browserDir, "main-MAINAAAA.js"), 'import("./chunk-LAZYAAAA.js");');
    writeFileSync(join(browserDir, "chunk-LAZYAAAA.js"), "export const lazy=1;");
    writeFileSync(join(browserDir, "styles-STYLAAAA.css"), "a{}");
    const serverDir = join(browserDir, "..", "server");
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(
      join(serverDir, "angular-app-manifest.mjs"),
      'export default {"index.csr.html":"<script src=\\"main-MAINAAAA.js\\"></script>"};',
    );
  }

  it("renames every hashed browser chunk and rewrites the HTML, imports and server manifest", async () => {
    hashedOutput();
    await afterpackAngular({ cwd: root, seed: 3 });
    const names = readdirSync(browserDir).sort();
    const main = names.find((name) => name.startsWith("main-")) as string;
    const lazy = names.find((name) => name.startsWith("chunk-")) as string;
    const polyfills = names.find((name) => name.startsWith("polyfills-")) as string;
    expect(main).toMatch(/^main-[A-Z2-7]{8}\.js$/);
    expect(main).not.toBe("main-MAINAAAA.js");
    expect(lazy).not.toBe("chunk-LAZYAAAA.js");
    expect(polyfills).not.toBe("polyfills-POLYAAAA.js");
    expect(names).toContain("styles-STYLAAAA.css");
    expect(readFileSync(join(browserDir, "index.html"), "utf8")).toBe(
      `<script src="${polyfills}" type="module"></script><script src="${main}" type="module"></script>`,
    );
    expect(readFileSync(join(browserDir, main), "utf8")).toBe(`OBF:import("./${lazy}");`);
    expect(
      readFileSync(join(browserDir, "..", "server", "angular-app-manifest.mjs"), "utf8"),
    ).toContain(`<script src=\\"${main}\\">`);
  });

  it("gives the same name to the same bytes, and new names to a new seed", async () => {
    const namesFor = async (seed: number): Promise<string[]> => {
      rmSync(join(root, "dist"), { recursive: true, force: true });
      rmSync(join(root, ".afterpack"), { recursive: true, force: true });
      mkdirSync(browserDir, { recursive: true });
      hashedOutput();
      await afterpackAngular({ cwd: root, seed });
      return readdirSync(browserDir).sort();
    };
    const first = await namesFor(3);
    expect(await namesFor(3)).toEqual(first);
    const other = await namesFor(4);
    expect(other.filter((name) => name.endsWith(".js") && first.includes(name))).toEqual([]);
  });
});
