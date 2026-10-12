import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { matchesPath } from "./glob.js";
import type { EngineFileResult } from "./pass.js";
import type { CoreConfig } from "./policy.js";
import {
  EXTERNAL_WIRE_DIR,
  prepareWireBatch,
  toWirePaths,
  WirePathError,
  wireEngineConfig,
  wireSourceMap,
} from "./wire.js";

const root = mkdtempSync(join(tmpdir(), "afterpack-wire-"));
const project = join(root, "app");
const dist = join(project, "dist");
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
    const outside = [join(project, "other", "x.js"), join(homedir(), "elsewhere", "x.js")];
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
  const src = join(project, "src", "greet.ts");
  const sent = (map: unknown) =>
    JSON.parse(wireSourceMap(JSON.stringify(map), mapDir, project) ?? "{}");

  it("returns an untouched map byte for byte", () => {
    const json =
      '{"version":3,"sources":["../../../src/greet.ts","webpack://_N_E/./a.ts"],"mappings":""}';
    expect(wireSourceMap(json, mapDir, project)).toBe(json);
  });

  it("rewrites absolute, file: and scheme-prefixed local sources relative to the map", () => {
    const out = sent({
      version: 3,
      file: join(mapDir, "x.js"),
      sources: [
        src,
        pathToFileURL(join(project, "src", "b.ts")).href,
        `webpack://${join(project, "src", "c.ts")}`,
        "webpack:///src/kept.ts",
      ],
      mappings: "",
    });
    expect(out.sources).toEqual([
      "../../../src/greet.ts",
      "../../../src/b.ts",
      "../../../src/c.ts",
      "webpack:///src/kept.ts",
    ]);
    expect(out.file).toBe("x.js");
  });

  it("keeps two spellings of one file distinct so each can be handed back", () => {
    const out = sent({ version: 3, sources: [src, pathToFileURL(src).href], mappings: "" });
    expect(out.sources[0]).toBe("../../../src/greet.ts");
    expect(out.sources[1]).not.toBe(out.sources[0]);
    expect(out.sources[1]).not.toContain(root);
  });

  it("folds a local sourceRoot into the sources and drops it", () => {
    const out = sent({
      version: 3,
      sourceRoot: `${project}/`,
      sources: ["src/greet.ts"],
      mappings: "",
    });
    expect(out.sourceRoot).toBeUndefined();
    expect(out.sources).toEqual(["../../../src/greet.ts"]);
  });

  it("rewrites the maps nested in an index map", () => {
    const out = sent({
      version: 3,
      sections: [
        { offset: { line: 0, column: 0 }, map: { version: 3, sources: [src], mappings: "" } },
      ],
    });
    expect(out.sections[0].map.sources).toEqual(["../../../src/greet.ts"]);
  });

  it("rewrites a local path embedded in a source name", () => {
    const out = sent({
      version: 3,
      sources: [
        `webpack://_N_E/ignored|${project}/node_modules/next/dist/lib|x`,
        "webpack://_N_E/?969b",
      ],
      mappings: "",
    });
    expect(out.sources).toEqual([
      "webpack://_N_E/ignored|../../../node_modules/next/dist/lib|x",
      "webpack://_N_E/?969b",
    ]);
  });

  it("replaces a local path in the source content with one of the same length, so offsets hold", () => {
    const user = basename(homedir());
    const escapedProject = project.replaceAll("/", "\\/");
    const contents = [
      "const a = 1 / 2;",
      `import(/* eager */ "${project}/app/page.tsx");`,
      `const home = "${homedir()}"; const slash = "${homedir()}/";`,
      `const json = "${escapedProject}\\/app\\/a.js";`,
      `const win = "C:\\Users\\${user}\\app\\a.js";`,
    ];
    const out = sent({ version: 3, sources: ["a.ts"], sourcesContent: contents, mappings: "" });
    expect(out.sourcesContent[0]).toBe(contents[0]);
    contents.forEach((content, i) => {
      expect(out.sourcesContent[i]).toHaveLength(content.length);
      expect(out.sourcesContent[i]).not.toContain(root);
      expect(out.sourcesContent[i]).not.toContain(homedir());
    });
    expect(out.sourcesContent[1].startsWith('import(/* eager */ ".')).toBe(true);
    expect(out.sourcesContent[1].endsWith('../../app/page.tsx");')).toBe(true);
    expect(out.sourcesContent[2]).not.toContain(user);
    expect(out.sourcesContent[3]).not.toContain(escapedProject);
    expect(out.sourcesContent[4]).not.toContain(user);
  });

  it("labels each source outside the project uniquely, without its directories", () => {
    const out = sent({
      version: 3,
      sources: [
        "/Users/someone/other/a/index.ts",
        "/Users/someone/other/b/index.ts",
        join(root, "elsewhere", "lib.ts"),
      ],
      mappings: "",
    });
    expect(new Set(out.sources).size).toBe(3);
    for (const source of out.sources) {
      expect(source.startsWith(`${EXTERNAL_WIRE_DIR}/`)).toBe(true);
      expect(source).not.toContain("someone");
      expect(source).not.toContain(root);
    }
    expect(out.sources[2].endsWith("/lib.ts")).toBe(true);
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

  it("refuses a translation that would select different files", () => {
    const odd = toWirePaths([join(dist, "a*.js"), join(dist, "abc.js")], dist);
    expect(() =>
      wireEngineConfig({ ...BASE, paths: { exclude: [join(dist, "a?.js")] } }, odd),
    ).toThrow(WirePathError);
  });

  it("leaves a config without path globs untouched", () => {
    const config = { ...BASE, preset: "hard" as const };
    expect(wireEngineConfig(config, wire)).toBe(config);
  });
});

describe("prepareWireBatch", () => {
  const file = join(dist, "static", "chunks", "x.js");
  const src = join(project, "src", "greet.ts");

  function resultFor(
    batch: ReturnType<typeof prepareWireBatch>,
    fields: Partial<EngineFileResult>,
  ): EngineFileResult {
    return batch.toLocal({
      files: [{ path: batch.inputs[0].path, code: "b", status: "success", ...fields }],
      totalFiles: 1,
      successCount: 1,
      failureCount: 0,
      source: "cloud",
    }).files[0];
  }

  it("maps results and their diagnostics back to the local files", () => {
    const other = join(dist, "server", "chunks", "x.js");
    const batch = prepareWireBatch(
      [
        { path: file, source: "a" },
        { path: other, source: "b" },
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
      [file, "OBF:a", file],
      [other, "OBF:b", other],
    ]);
  });

  it("hands back the output map of a file that had no input map with its local path", () => {
    const batch = prepareWireBatch([{ path: file, source: "a" }], BASE, dist, project);
    const out = resultFor(batch, {
      sourceMap: '{"version":3,"sources":["static/chunks/x.js"],"mappings":""}',
    });
    expect(JSON.parse(out.sourceMap ?? "{}").sources).toEqual([file]);
  });

  it("hands back sources, sourceRoot, file, content and Protection Map exactly as they were", () => {
    const original = {
      version: 3,
      file,
      sourceRoot: `${project}/`,
      sources: ["src/greet.ts"],
      sourcesContent: [`import "${src}";`],
      mappings: "",
    };
    const batch = prepareWireBatch(
      [{ path: file, source: "a", sourceMap: JSON.stringify(original) }],
      BASE,
      dist,
      project,
    );
    const wired = JSON.parse(batch.inputs[0].sourceMap ?? "{}");
    expect(wired.sources).toEqual(["../../../src/greet.ts"]);
    expect(wired.sourcesContent[0]).toHaveLength(original.sourcesContent[0].length);
    const pmFile = (path: string, content: string) => ({
      file: { path, originalSource: content, inputSize: content.length, outputSize: 1 },
      regions: [],
      spotlights: [],
      aggregate: {},
    });
    const out = resultFor(batch, {
      sourceMap: JSON.stringify(wired),
      protectionMap: {
        schemaVersion: 3,
        generatedAt: null,
        engine: { version: "t", backend: "t", seed: 0, preset: null, complexity: 0 },
        files: [
          pmFile(wired.sources[0], wired.sourcesContent[0]),
          pmFile("static/chunks/x.js", "a"),
        ],
      },
    });
    const back = JSON.parse(out.sourceMap ?? "{}");
    expect(back).toEqual(original);
    expect(Object.keys(back)).toEqual([
      "version",
      "file",
      "sources",
      "sourceRoot",
      "sourcesContent",
      "mappings",
    ]);
    expect(
      out.protectionMap?.files.map((f) => [f.file.path, f.file.originalSource, f.file.inputSize]),
    ).toEqual([
      [src, original.sourcesContent[0], original.sourcesContent[0].length],
      [file, "a", 1],
    ]);
  });

  it("names the user's own pattern and file in a diagnostic", () => {
    const batch = prepareWireBatch(
      [{ path: file, source: "a" }],
      { ...BASE, paths: { exclude: [file] } },
      dist,
      project,
    );
    expect(batch.config.paths?.exclude).toEqual(["/static/chunks/x.js"]);
    const out = resultFor(batch, {
      diagnostics: [
        {
          severity: "info",
          code: "DIAG_PATH_EXCLUDED",
          message:
            'Excluded by paths.exclude pattern "/static/chunks/x.js": in static/chunks/x.js.',
          file: "static/chunks/x.js",
        },
      ],
    });
    expect(out.diagnostics?.[0]).toMatchObject({
      file,
      message: `Excluded by paths.exclude pattern "${file}": in ${file}.`,
    });
  });
});
