import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { matchesPath } from "./glob.js";
import type { CoreConfig } from "./policy.js";
import {
  EXTERNAL_WIRE_DIR,
  prepareWireBatch,
  toWirePaths,
  wireEngineConfig,
  wireSourceMap,
} from "./wire.js";

const root = mkdtempSync(join(tmpdir(), "afterpack-wire-"));
const dist = join(root, "app", "dist");
mkdirSync(join(dist, "static", "chunks"), { recursive: true });

afterAll(() => rmSync(root, { recursive: true, force: true }));

const BASE: CoreConfig = {
  seed: 1,
  sourceMap: { sourcesContent: false },
  protectionMap: { enabled: false },
};

describe("toWirePaths", () => {
  it("sends each file relative to the build directory with forward slashes", () => {
    const wire = toWirePaths([join(dist, "static", "chunks", "x.js"), join(dist, "a.js")], dist);
    expect([...wire.values()]).toEqual(["static/chunks/x.js", "a.js"]);
  });

  it("keeps the same basename in different directories distinct", () => {
    const files = [
      join(dist, "static", "chunks", "x.js"),
      join(dist, "server", "chunks", "x.js"),
      join(dist, "server", "app", "static", "chunks", "x.js"),
    ];
    const wire = toWirePaths(files, dist);
    expect(new Set(wire.values()).size).toBe(3);
    expect(wire.get(files[1])).toBe("server/chunks/x.js");
  });

  it("labels a file outside the build directory without naming where it lives", () => {
    const outside = [join(root, "app", "other", "x.js"), join(homedir(), "elsewhere", "x.js")];
    const wire = toWirePaths([join(dist, "x.js"), ...outside], dist);
    const labels = outside.map((f) => wire.get(f) ?? "");
    expect(new Set([wire.get(join(dist, "x.js")), ...labels]).size).toBe(3);
    for (const label of labels) {
      expect(label.startsWith(`${EXTERNAL_WIRE_DIR}/`)).toBe(true);
      expect(label.endsWith("/x.js")).toBe(true);
      expect(label).not.toContain("..");
      expect(label).not.toContain(root);
      expect(label).not.toContain(homedir());
    }
  });
});

describe("wireSourceMap", () => {
  const mapDir = join(dist, "static", "chunks");
  const project = join(root, "app");
  const src = join(project, "src", "greet.ts");

  it("returns an untouched map byte for byte", () => {
    const json =
      '{"version":3,"sources":["../../../src/greet.ts","webpack://_N_E/./a.ts"],"mappings":""}';
    expect(wireSourceMap(json, mapDir, project)).toBe(json);
  });

  it("rewrites absolute, file: and scheme-prefixed local sources relative to the map", () => {
    const json = JSON.stringify({
      version: 3,
      file: join(mapDir, "x.js"),
      sources: [src, pathToFileURL(src).href, `webpack://${src}`, "webpack:///src/kept.ts"],
      sourcesContent: ["a", "b", "c", "d"],
      mappings: "",
    });
    const out = JSON.parse(wireSourceMap(json, mapDir, project) ?? "{}");
    expect(out.sources).toEqual([
      "../../../src/greet.ts",
      "../../../src/greet.ts",
      "../../../src/greet.ts",
      "webpack:///src/kept.ts",
    ]);
    expect(out.file).toBe("x.js");
    expect(out.sourcesContent).toEqual(["a", "b", "c", "d"]);
  });

  it("folds a local sourceRoot into the sources and drops it", () => {
    const json = JSON.stringify({
      version: 3,
      sourceRoot: `${join(root, "app")}/`,
      sources: ["src/greet.ts"],
      mappings: "",
    });
    const out = JSON.parse(wireSourceMap(json, mapDir, project) ?? "{}");
    expect(out.sourceRoot).toBeUndefined();
    expect(out.sources).toEqual(["../../../src/greet.ts"]);
  });

  it("rewrites the maps nested in an index map", () => {
    const json = JSON.stringify({
      version: 3,
      sections: [
        { offset: { line: 0, column: 0 }, map: { version: 3, sources: [src], mappings: "" } },
      ],
    });
    const out = JSON.parse(wireSourceMap(json, mapDir, project) ?? "{}");
    expect(out.sections[0].map.sources).toEqual(["../../../src/greet.ts"]);
  });

  it("rewrites a local path embedded in a source name or in the source content", () => {
    const json = JSON.stringify({
      version: 3,
      sources: [
        `webpack://_N_E/ignored|${project}/node_modules/next/dist/lib|x`,
        "webpack://_N_E/?969b",
      ],
      sourcesContent: ["const a = 1 / 2;", `import(/* eager */ "${project}/app/page.tsx");`],
      mappings: "",
    });
    const out = JSON.parse(wireSourceMap(json, mapDir, project) ?? "{}");
    expect(out.sources).toEqual([
      "webpack://_N_E/ignored|../../../node_modules/next/dist/lib|x",
      "webpack://_N_E/?969b",
    ]);
    expect(out.sourcesContent).toEqual([
      "const a = 1 / 2;",
      'import(/* eager */ "../../../app/page.tsx");',
    ]);
  });

  it("names a source outside the project by its file name alone", () => {
    const json = JSON.stringify({
      version: 3,
      sources: ["/Users/someone/proj/src/greet.ts", join(root, "elsewhere", "lib.ts")],
      mappings: "",
    });
    const out = JSON.parse(wireSourceMap(json, mapDir, project) ?? "{}");
    expect(out.sources).toEqual(["greet.ts", "lib.ts"]);
  });

  it("drops a map it cannot read rather than forward it", () => {
    expect(wireSourceMap(`not json ${src}`, mapDir, project)).toBeUndefined();
  });
});

describe("wireEngineConfig", () => {
  const files = [
    join(dist, "static", "chunks", "x.js"),
    join(dist, "server", "chunks", "x.js"),
    join(dist, "vendor", "lib.js"),
  ];
  const wire = toWirePaths(files, dist);

  function excludedBy(patterns: string[], path: string): boolean {
    return patterns.some((p) => matchesPath(p, path));
  }

  it("excludes exactly the same files as the patterns did against the local paths", () => {
    const exclude = [
      "vendor/**",
      "dist/static/**",
      join(dist, "server", "chunks", "x.js"),
      join(root, "nothing-here.js"),
    ];
    const out = wireEngineConfig({ ...BASE, paths: { exclude } }, wire);
    const sent = out.paths?.exclude ?? [];
    expect(sent).toContain("vendor/**");
    for (const file of files) {
      expect(excludedBy(sent, wire.get(file) ?? "")).toBe(excludedBy(exclude, file));
    }
    expect(sent.join("\n")).not.toContain(root);
  });

  it("scopes reserved names to the same files and keeps bare names", () => {
    const reserved = ["keepMe", { glob: "app/dist/server/**", names: ["serverOnly"] }];
    const out = wireEngineConfig({ ...BASE, identifiers: { reserved } }, wire);
    expect(out.identifiers?.reserved).toEqual([
      "keepMe",
      { glob: "/server/chunks/x.js", names: ["serverOnly"] },
    ]);
  });

  it("leaves a config without path globs untouched", () => {
    const config = { ...BASE, preset: "hard" as const };
    expect(wireEngineConfig(config, wire)).toBe(config);
  });
});

describe("prepareWireBatch", () => {
  it("maps results and their diagnostics back to the local files", () => {
    const a = join(dist, "static", "chunks", "x.js");
    const b = join(dist, "server", "chunks", "x.js");
    const batch = prepareWireBatch(
      [
        { path: a, source: "a" },
        { path: b, source: "b" },
      ],
      BASE,
      dist,
    );
    expect(batch.inputs.map((i) => i.path)).toEqual(["static/chunks/x.js", "server/chunks/x.js"]);
    const local = batch.toLocal({
      files: batch.inputs.map((i) => ({
        path: i.path,
        code: `OBF:${i.source}`,
        status: "success" as const,
        diagnostics: [{ severity: "info" as const, code: "DIAG_X", message: "m", file: i.path }],
      })),
      totalFiles: 2,
      successCount: 2,
      failureCount: 0,
      source: "cloud",
    });
    expect(local.files.map((f) => [f.path, f.code, f.diagnostics?.[0]?.file])).toEqual([
      [a, "OBF:a", a],
      [b, "OBF:b", b],
    ]);
  });

  it("hands back the engine's source map and Protection Map with the local paths they replaced", () => {
    const file = join(dist, "static", "chunks", "x.js");
    const src = join(root, "app", "src", "greet.ts");
    const batch = prepareWireBatch(
      [
        {
          path: file,
          source: "a",
          sourceMap: JSON.stringify({
            version: 3,
            sources: [src],
            sourcesContent: [`import "${src}";`],
            mappings: "",
          }),
        },
      ],
      BASE,
      dist,
      join(root, "app"),
    );
    const sentMap = JSON.parse(batch.inputs[0].sourceMap ?? "{}");
    expect(sentMap.sources).toEqual(["../../../src/greet.ts"]);
    const pm = {
      schemaVersion: 3,
      generatedAt: null,
      engine: { version: "t", backend: "t", seed: 0, preset: null, complexity: 0 },
      files: [
        {
          file: { path: "../../../src/greet.ts", originalSource: "a", inputSize: 1, outputSize: 1 },
          regions: [],
          spotlights: [],
          aggregate: {},
        },
        {
          file: { path: "static/chunks/x.js", originalSource: "a", inputSize: 1, outputSize: 1 },
          regions: [],
          spotlights: [],
          aggregate: {},
        },
      ],
    };
    const [result] = batch.toLocal({
      files: [
        {
          path: "static/chunks/x.js",
          code: "b",
          status: "success",
          sourceMap: batch.inputs[0].sourceMap,
          protectionMap: pm,
        },
      ],
      totalFiles: 1,
      successCount: 1,
      failureCount: 0,
      source: "cloud",
    }).files;
    expect(sentMap.sourcesContent).toEqual(['import "../../../src/greet.ts";']);
    expect(JSON.parse(result.sourceMap ?? "{}").sources).toEqual([src]);
    expect(JSON.parse(result.sourceMap ?? "{}").sourcesContent).toEqual([`import "${src}";`]);
    expect(result.protectionMap?.files.map((f) => f.file.path)).toEqual([src, file]);
  });
});
