import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { ProtectionMap } from "@afterpack/protection-map";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildProjectFileTree,
  cleanSourcePath,
  ensureAfterpackGitignore,
  isRuntimeSource,
  type Logger,
  warnIfPublicPath,
  writeArtifacts,
  writeCombinedProtectionMap,
} from "./artifacts.js";
import { resolveReportPolicy } from "./policy.js";

const { decodeCompact } = (await import(
  new URL("../../protection-map/codec.mjs", import.meta.url).href
)) as { decodeCompact: (compact: unknown) => unknown };

const LANE_FREE_MERGE =
  '[{"file":{"path":"app/shared.tsx","sourceOrigin":"original","vendor":false,"originalSource":"const total = price * qty;\\nexport const label = total + 1;\\n","inputSize":57,"bundledInputSize":80,"outputSize":160,"outputSizeEstimated":true,"inflationRatio":2},"regions":[{"span":[14,19],"reversalClass":"flattened-fused","score":60,"entropy":0.6,"entropyRaw":6,"transformCount":1,"sizeDeltaEst":3,"perf":{"costClass":"none","decodeOps":0,"callFrames":0},"lineage":[{"transform":"ScopeDeepen"}]},{"span":[6,11],"reversalClass":"renamed-encoded","score":40,"entropy":0.4,"entropyRaw":4,"transformCount":1,"sizeDeltaEst":3,"perf":{"costClass":"none","decodeOps":0,"callFrames":0},"lineage":[{"transform":"ScopeDeepen"}]},{"span":[33,38],"reversalClass":"renamed-encoded","score":20,"entropy":0.2,"entropyRaw":2,"transformCount":1,"sizeDeltaEst":3,"perf":{"costClass":"none","decodeOps":0,"callFrames":0},"lineage":[{"transform":"ScopeDeepen"}]}],"spotlights":[{"span":[44,45],"severity":"leak","sample":"x","reason":"r"}],"renamedSpans":[[6,11],[14,19],[33,38]],"extractedSpans":[14,19,0,22,25,1],"aggregate":{"avgEntropy":0.4,"maxEntropy":0.6,"minEntropy":0.2,"totalTransforms":3,"renamedCount":3,"extractedCount":2,"weakRegions":1,"leakCount":1,"perfCostTotal":{"decodeOps":0,"callFrames":0},"sizeDeltaEstTotal":9,"classSummary":{"preserved":0,"renamed-encoded":2,"flattened-fused":1,"destroyed-fused":0,"maxClassReached":"flattened-fused"},"directives":[{"keyword":"skip","span":[0,5]}]}}]';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "afterpack-artifacts-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function captureLogger(): { logger: Logger; warns: string[]; logs: string[] } {
  const warns: string[] = [];
  const logs: string[] = [];
  return { logger: { warn: (m) => warns.push(m), log: (m) => logs.push(m) }, warns, logs };
}

function pmDoc(path: string): ProtectionMap {
  const legacyFileShapedDoc = {
    file: { path, bytes: 10, sourceOrigin: "original" },
    source: "const x = 1;",
    regions: [],
    spotlights: [],
    aggregate: { classSummary: {} },
  };
  return legacyFileShapedDoc as unknown as ProtectionMap;
}

function assertSelfContained(html: string) {
  expect(html).not.toMatch(/https?:\/\//i);
  expect(html).not.toMatch(/<script[^>]+\bsrc=/i);
  expect(html).not.toMatch(/<link\b/i);
  expect(html).not.toMatch(/<img[^>]+\bsrc=/i);
  expect(html).not.toMatch(/@import/i);
}

function embeddedData(html: string): {
  schemaVersion?: number;
  engine?: unknown;
  files: Array<{ file: { path?: string } }>;
} {
  const m = html.match(/<script id="afterpack-data"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("no embedded afterpack-data script in the HTML");
  const payload = m[1].trim();
  if (payload[0] === "{") return JSON.parse(payload) as ReturnType<typeof embeddedData>;
  const json = gunzipSync(Buffer.from(payload, "base64")).toString("utf8");
  return decodeCompact(JSON.parse(json)) as ReturnType<typeof embeddedData>;
}

function embeddedPaths(html: string): Array<string | undefined> {
  return embeddedData(html).files.map((f) => f.file.path);
}

describe("writeArtifacts — single-file mode, dev policy", () => {
  it("writes the backup, code+sourceMappingURL, the .map, and a self-contained PM html", () => {
    const policy = resolveReportPolicy({}, {}, { hasBundlerSourcemap: true });
    const outPath = join(dir, "main.js");
    const original = "export const a = 1;\n";
    const result = writeArtifacts({
      outPath,
      code: "const _0x1=1;",
      sourceMapJson: '{"version":3,"file":"main.js"}',
      protectionMapJson: pmDoc("main.js"),
      originalSource: original,
      policy,
      mode: "single",
      afterpackDir: join(dir, ".afterpack"),
    });

    expect(result.backupPath).not.toBeNull();
    expect(readFileSync(result.backupPath as string, "utf8")).toBe(original);
    const written = readFileSync(outPath, "utf8");
    expect(written).toContain("const _0x1=1;");

    expect(result.mapPath).toBe(`${outPath}.map`);
    expect(readFileSync(result.mapPath as string, "utf8")).toContain('"version":3');
    expect(result.wroteSourceMappingURL).toBe(true);
    expect(written).toContain(`//# sourceMappingURL=${basename(outPath)}.map`);

    expect(result.protectionMapPath).toBe(join(dir, ".afterpack", "main.protectionMap.html"));
    expect(existsSync(join(dir, "main.protectionMap.html"))).toBe(false);
    const pm = readFileSync(result.protectionMapPath as string, "utf8");
    assertSelfContained(pm);
    expect(embeddedPaths(pm)).toContain("main.js");
  });
});

describe("writeArtifacts — production policy", () => {
  it("writes NO .map (prod maps-off) and no PM, but keeps the backup", () => {
    const policy = resolveReportPolicy({ NODE_ENV: "production" }, {});
    const outPath = join(dir, "chunk.js");
    const result = writeArtifacts({
      outPath,
      code: "const _0x1=1;",
      sourceMapJson: '{"version":3}',
      protectionMapJson: pmDoc("chunk.js"),
      originalSource: "orig",
      policy,
      mode: "single",
    });

    expect(result.mapPath).toBeNull();
    expect(existsSync(`${outPath}.map`)).toBe(false);
    expect(result.wroteSourceMappingURL).toBe(false);
    expect(readFileSync(outPath, "utf8")).not.toContain("sourceMappingURL");
    expect(result.protectionMapPath).toBeNull();
    expect(result.backupPath).not.toBeNull();
  });

  it("force-enabling PM in prod redirects it to the self-ignoring .afterpack/ and logs calmly", () => {
    const policy = resolveReportPolicy(
      { NODE_ENV: "production" },
      { protectionMap: { enabled: true } },
    );
    const cap = captureLogger();
    const outPath = join(dir, "main.js");
    const result = writeArtifacts({
      outPath,
      code: "x",
      sourceMapJson: null,
      protectionMapJson: pmDoc("main.js"),
      originalSource: "orig",
      policy,
      mode: "single",
      afterpackDir: join(dir, ".afterpack"),
      logger: cap.logger,
    });

    expect(result.protectionMapPath).toBe(join(dir, ".afterpack", "main.protectionMap.html"));
    expect(existsSync(result.protectionMapPath as string)).toBe(true);
    expect(existsSync(join(dir, "main.protectionMap.html"))).toBe(false);
    expect(readFileSync(join(dir, ".afterpack", ".gitignore"), "utf8")).toBe("*\n");
    expect(cap.warns).toEqual([]);
    expect(cap.logs.join("\n")).toMatch(/Protection Map/);
    expect(cap.logs.join("\n")).toMatch(/local only, not deployed/);
  });
});

describe("writeArtifacts — source-map feature disabled", () => {
  it("writes no .map and no comment when policy.sourceMap is false", () => {
    const policy = resolveReportPolicy({}, { sourceMap: { enabled: false } });
    const outPath = join(dir, "m.js");
    const result = writeArtifacts({
      outPath,
      code: "x",
      sourceMapJson: '{"version":3}',
      protectionMapJson: null,
      originalSource: "orig",
      policy,
      mode: "single",
    });
    expect(result.mapPath).toBeNull();
    expect(existsSync(`${outPath}.map`)).toBe(false);
    expect(result.wroteSourceMappingURL).toBe(false);
  });
});

describe("writeCombinedProtectionMap — directory / framework build", () => {
  it("writes ONE self-contained protectionMap.html (in .afterpack/) covering every file's doc", () => {
    const policy = resolveReportPolicy({}, {}, { hasBundlerSourcemap: true });
    const out = writeCombinedProtectionMap({
      buildDir: dir,
      docs: [pmDoc("a/main.js"), pmDoc("b/page.js")],
      policy,
      afterpackDir: join(dir, ".afterpack"),
    });
    expect(out).toBe(join(dir, ".afterpack", "protectionMap.html"));
    expect(existsSync(join(dir, "protectionMap.html"))).toBe(false);
    const html = readFileSync(out as string, "utf8");
    assertSelfContained(html);
    expect(embeddedPaths(html)).toEqual(["a/main.js", "b/page.js"]);
  });

  it("carries both lanes of a file split across chunks into the rendered page", () => {
    const policy = resolveReportPolicy({}, {}, { hasBundlerSourcemap: true });
    const chunkDoc = (complexitySpans: number[], kinds: string[], spans: number[]) =>
      ({
        schemaVersion: 4,
        spanUnits: "utf16",
        engine: { version: "0.1.1", preset: "medium" },
        files: [
          {
            file: {
              path: "webpack://_N_E/./app/shared.tsx",
              sourceOrigin: "original",
              originalSource: "var total = 1;\n",
              inputSize: 15,
            },
            regions: [],
            spotlights: [],
            renamedSpans: [[4, 9]],
            extractedSpans: [],
            complexitySpans,
            declarationKinds: kinds,
            declarationSpans: spans,
            aggregate: { classSummary: {} },
          },
        ],
      }) as unknown as ProtectionMap;
    const out = writeCombinedProtectionMap({
      buildDir: dir,
      docs: [
        chunkDoc([4, 9, 7, 12, 13, 3], ["LowerVarToLet"], [4, 9, 0]),
        chunkDoc([4, 9, 5], ["LowerVarToLet", "DeclarationChaining"], [4, 9, 1]),
      ],
      policy,
      afterpackDir: join(dir, ".afterpack"),
    });
    const [page] = embeddedData(readFileSync(out as string, "utf8")).files as Array<
      Record<string, unknown>
    >;
    expect(page.complexitySpans).toEqual([4, 9, 5, 12, 13, 3]);
    expect(page.declarationKinds).toEqual(["LowerVarToLet", "DeclarationChaining"]);
    expect(page.declarationSpans).toEqual([4, 9, 0, 4, 9, 1]);
  });

  it("returns null when PM is disabled or there are no docs", () => {
    const off = resolveReportPolicy({ NODE_ENV: "production" }, {});
    expect(
      writeCombinedProtectionMap({ buildDir: dir, docs: [pmDoc("x")], policy: off }),
    ).toBeNull();
    const on = resolveReportPolicy({}, {});
    expect(writeCombinedProtectionMap({ buildDir: dir, docs: [], policy: on })).toBeNull();
  });

  it("redirects a prod-forced combined PM into .afterpack/ and logs calmly", () => {
    const policy = resolveReportPolicy(
      { NODE_ENV: "production" },
      { protectionMap: { enabled: true } },
    );
    const cap = captureLogger();
    const out = writeCombinedProtectionMap({
      buildDir: dir,
      docs: [pmDoc("x")],
      policy,
      afterpackDir: join(dir, ".afterpack"),
      logger: cap.logger,
    });
    expect(out).toBe(join(dir, ".afterpack", "protectionMap.html"));
    expect(readFileSync(join(dir, ".afterpack", ".gitignore"), "utf8")).toBe("*\n");
    expect(cap.warns).toEqual([]);
    expect(cap.logs.join("\n")).toMatch(/Protection Map/);
    expect(cap.logs.join("\n")).toMatch(/local only, not deployed/);
  });

  function v3Doc(backend: string, paths: string[]): ProtectionMap {
    return {
      schemaVersion: 3,
      generatedAt: null,
      engine: { backend, preset: "medium", seed: 7, version: "9.9.9", complexity: 8 },
      files: paths.map((path) => ({
        file: {
          path,
          sourceOrigin: "original",
          originalSource: "const x = 1;",
          inputSize: 12,
          outputSize: 12,
        },
        regions: [],
        spotlights: [],
        aggregate: { classSummary: {} },
      })),
    };
  }

  it("CONCATENATES each v3 doc's own files[] and preserves the v3 envelope", () => {
    const policy = resolveReportPolicy({}, {}, { hasBundlerSourcemap: true });
    const out = writeCombinedProtectionMap({
      buildDir: dir,
      docs: [
        v3Doc("core-v1", ["src/a.ts", "src/b.ts"]),
        v3Doc("core-v1", ["src/c.ts", "src/d.ts", "vendor/e.ts"]),
      ],
      policy,
      afterpackDir: join(dir, ".afterpack"),
    });
    const html = readFileSync(out as string, "utf8");
    assertSelfContained(html);

    const data = embeddedData(html);
    expect(data.files).toHaveLength(5);
    expect((data.files as Array<{ file: { path: string } }>).map((f) => f.file.path)).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "src/d.ts",
      "vendor/e.ts",
    ]);
    expect(data.schemaVersion).toBe(5);
    expect(data.engine).toMatchObject({ backend: "core-v1", preset: "medium", seed: 7 });
  });

  it("derives the v3 envelope from the FIRST doc that HAS one (mixed-shape batch)", () => {
    const policy = resolveReportPolicy({}, {}, { hasBundlerSourcemap: true });
    const out = writeCombinedProtectionMap({
      buildDir: dir,
      docs: [pmDoc("legacy/one.js"), v3Doc("core-v1", ["src/x.ts", "src/y.ts"])],
      policy,
      afterpackDir: join(dir, ".afterpack"),
    });
    const data = embeddedData(readFileSync(out as string, "utf8"));
    expect(data.files).toHaveLength(3);
    expect(data.schemaVersion).toBe(5);
    expect(data.engine).toMatchObject({ backend: "core-v1" });
  });
});

describe("buildProjectFileTree — project-source tree normalization", () => {
  function region(
    span: [number, number],
    reversalClass: string,
    entropy: number,
    entropyRaw: number,
    transformCount: number,
    sizeDeltaEst: number,
    perf: { decodeOps: number; callFrames: number },
  ) {
    return {
      span,
      reversalClass,
      entropy,
      entropyRaw,
      transformCount,
      sizeDeltaEst,
      perf,
      lineage: Array.from({ length: transformCount }, (_, i) => ({ transform: `T${i}` })),
    };
  }

  function original(
    path: string,
    originalSource: string,
    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous test fixtures
    regions: any[],
    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous test fixtures
    spotlights: any[],
    vendor = false,
  ) {
    return {
      file: { path, sourceOrigin: "original", vendor, originalSource, inputSize: 100 },
      regions,
      spotlights,
      aggregate: { classSummary: {} },
    };
  }

  it("drops dist chunks + runtime, merges the split source, strips prefixes, keeps+flags vendor", () => {
    const files = [
      {
        file: { path: ".next/static/chunks/main-abc.js", sourceOrigin: "engineInput" },
        regions: [region([0, 5], "renamed-encoded", 0.3, 3, 1, 2, { decodeOps: 0, callFrames: 0 })],
        spotlights: [],
      },
      original(
        "turbopack:///[project]/app/(dash)/page.tsx",
        "PAGE_SRC",
        [region([0, 10], "renamed-encoded", 0.5, 5, 2, 4, { decodeOps: 1, callFrames: 0 })],
        [{ span: [2, 5], severity: "leak", sample: "secret" }],
      ),
      original(
        "turbopack:///[project]/app/(dash)/page.tsx",
        "PAGE_SRC",
        [
          region([0, 10], "renamed-encoded", 0.5, 5, 2, 4, { decodeOps: 1, callFrames: 0 }),
          region([20, 30], "flattened-fused", 0.8, 8, 3, 6, { decodeOps: 1, callFrames: 1 }),
        ],
        [
          { span: [2, 5], severity: "leak", sample: "secret" },
          { span: [40, 45], severity: "propertyName", sample: "name" },
        ],
      ),
      original(
        "turbopack:///[turbopack]/browser/dev/runtime.js",
        "RUNTIME",
        [region([0, 3], "renamed-encoded", 0.1, 1, 1, 1, { decodeOps: 0, callFrames: 0 })],
        [],
      ),
      original(
        "turbopack:///[project]/node_modules/.pnpm/lodash@4.17.21/node_modules/lodash/index.js",
        "LODASH",
        [],
        [],
        true,
      ),
    ];

    const tree = buildProjectFileTree(files);

    const paths = tree.map((e) => e.file?.path);
    expect(paths).not.toContain(".next/static/chunks/main-abc.js");
    expect(paths.some((p) => p?.includes("[turbopack]"))).toBe(false);
    expect(tree).toHaveLength(2);

    const page = tree.find((e) => e.file?.path === "app/(dash)/page.tsx");
    expect(page).toBeDefined();
    expect((page?.regions ?? []).map((r) => r.span)).toEqual([
      [20, 30],
      [0, 10],
    ]);
    const agg = page?.aggregate as {
      avgEntropy: number;
      maxEntropy: number;
      minEntropy: number;
      totalTransforms: number;
      weakRegions: number;
      leakCount: number;
      sizeDeltaEstTotal: number;
      perfCostTotal: { decodeOps: number; callFrames: number };
      classSummary: Record<string, number | string>;
    };
    expect(agg.totalTransforms).toBe(5);
    expect(agg.sizeDeltaEstTotal).toBe(10);
    expect(agg.avgEntropy).toBe(0.65);
    expect(agg.maxEntropy).toBe(0.8);
    expect(agg.minEntropy).toBe(0.5);
    expect(agg.perfCostTotal).toEqual({ decodeOps: 2, callFrames: 1 });
    expect(agg.weakRegions).toBe(2);
    expect(agg.leakCount).toBe(1);
    expect(agg.classSummary["renamed-encoded"]).toBe(1);
    expect(agg.classSummary["flattened-fused"]).toBe(1);
    expect(agg.classSummary.maxClassReached).toBe("flattened-fused");

    const vendor = tree.find((e) => e.file?.vendor === true);
    expect(vendor?.file?.path).toBe("node_modules/lodash/index.js");
  });

  it("sums a code-split file's output across chunks but not its input", () => {
    const a = original("webpack://_N_E/./app/page.tsx", "SRC", [], []) as Record<string, unknown>;
    (a.file as Record<string, unknown>).inputSize = 1000;
    (a.file as Record<string, unknown>).outputSize = 1800;
    (a.file as Record<string, unknown>).outputSizeEstimated = true;
    const b = original("webpack://_N_E/./app/page.tsx", "SRC", [], []) as Record<string, unknown>;
    (b.file as Record<string, unknown>).inputSize = 1000;
    (b.file as Record<string, unknown>).outputSize = 700;
    (b.file as Record<string, unknown>).outputSizeEstimated = false;

    const [page] = buildProjectFileTree([a, b]);
    expect(page.file?.outputSize).toBe(2500);
    expect(page.file?.inputSize).toBe(1000);
    expect(page.file?.outputSizeEstimated).toBe(true);
  });

  it("leaves output size absent when no chunk reported one", () => {
    const a = original("webpack://_N_E/./app/page.tsx", "SRC", [], []) as Record<string, unknown>;
    const [page] = buildProjectFileTree([a]);
    expect(page.file?.outputSize).toBeUndefined();
  });

  it("carries the flat Globals extraction lane through the merge, deduped + sorted", () => {
    const a = original("webpack://_N_E/./app/page.tsx", "SRC", [], []) as Record<string, unknown>;
    a.extractedSpans = [40, 47, 0, 10, 15, 1];
    const b = original("webpack://_N_E/./app/page.tsx", "SRC", [], []) as Record<string, unknown>;
    b.extractedSpans = [40, 47, 0, 22, 29, 0];

    const [page] = buildProjectFileTree([a, b]);
    expect(page.extractedSpans).toEqual([10, 15, 1, 22, 29, 0, 40, 47, 0]);
    expect((page.aggregate as { extractedCount: number }).extractedCount).toBe(3);
  });

  it("dedupes + sorts both span lanes exactly like the naive boxed reference", () => {
    const PACK_LIMIT = 1 << 25;
    let seed = 1234567;
    const rnd = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      return (seed >>> 8) % n;
    };
    const chunkA: number[] = [];
    const chunkB: number[] = [];
    for (let i = 0; i < 400; i++) {
      const start = rnd(5000);
      const triple = [start, start + rnd(20), rnd(2)];
      (i % 3 === 0 ? chunkA : chunkB).push(...triple);
      if (i % 5 === 0) chunkB.push(...triple);
    }
    chunkA.push(7, 9, 0, 7, 9, 1);
    chunkB.push(7, 9, 1);
    chunkA.push(PACK_LIMIT, PACK_LIMIT + 4, 1, PACK_LIMIT + 100, PACK_LIMIT + 104, 0);
    chunkB.push(PACK_LIMIT, PACK_LIMIT + 4, 1);
    chunkA.push(1, 2);

    const renA: [number, number][] = [];
    const renB: [number, number][] = [];
    for (let i = 0; i < 200; i++) {
      const start = rnd(4000);
      const pair: [number, number] = [start, start + rnd(12)];
      (i % 2 === 0 ? renA : renB).push(pair);
      if (i % 4 === 0) renB.push([pair[0], pair[1]]);
    }
    renA.push([PACK_LIMIT + 3, PACK_LIMIT + 9]);
    renB.push([PACK_LIMIT + 3, PACK_LIMIT + 9]);

    const seenRef = new Set<string>();
    const triples: number[][] = [];
    for (const flat of [chunkA, chunkB]) {
      for (let i = 0; i + 2 < flat.length; i += 3) {
        const key = `${flat[i]},${flat[i + 1]},${flat[i + 2]}`;
        if (seenRef.has(key)) continue;
        seenRef.add(key);
        triples.push([flat[i], flat[i + 1], flat[i + 2]]);
      }
    }
    triples.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
    const expectedExtracted = triples.flat();
    const seenRenRef = new Set<string>();
    const pairs: [number, number][] = [];
    for (const lane of [renA, renB]) {
      for (const rn of lane) {
        const key = `${rn[0]},${rn[1]}`;
        if (seenRenRef.has(key)) continue;
        seenRenRef.add(key);
        pairs.push(rn);
      }
    }
    pairs.sort((x, y) => x[0] - y[0] || x[1] - y[1]);

    const a = original("webpack://_N_E/./app/lanes.tsx", "SRC", [], []) as Record<string, unknown>;
    a.extractedSpans = chunkA;
    a.renamedSpans = renA;
    const b = original("webpack://_N_E/./app/lanes.tsx", "SRC", [], []) as Record<string, unknown>;
    b.extractedSpans = chunkB;
    b.renamedSpans = renB;

    const [page] = buildProjectFileTree([a, b]);
    expect(page.extractedSpans).toEqual(expectedExtracted);
    expect(page.renamedSpans).toEqual(pairs);
    const agg = page.aggregate as { extractedCount: number; renamedCount: number };
    expect(agg.extractedCount).toBe(expectedExtracted.length / 3);
    expect(agg.renamedCount).toBe(pairs.length);
    expect(expectedExtracted.length / 3).toBeGreaterThan(300);
    expect(expectedExtracted).toContain(PACK_LIMIT);
    const kindsAt79: number[] = [];
    const out = page.extractedSpans as number[];
    for (let i = 0; i + 2 < out.length; i += 3) {
      if (out[i] === 7 && out[i + 1] === 9) kindsAt79.push(out[i + 2]);
    }
    expect(kindsAt79).toEqual([0, 1]);
  });

  function permutations<T>(items: T[]): T[][] {
    if (items.length <= 1) return [items];
    return items.flatMap((x, i) =>
      permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [x, ...rest]),
    );
  }

  function laneChunk(lanes: Record<string, unknown>): Record<string, unknown> {
    return { ...original("webpack://_N_E/./app/heat.tsx", "SRC", [], []), ...lanes };
  }

  it("merges the complexity lane: a shared token keeps its weakest copy, nested tokens all stay, chunk order never matters", () => {
    const chunks = [
      laneChunk({ complexitySpans: [0, 10, 8, 0, 3, 12, 20, 25, 5] }),
      laneChunk({ complexitySpans: [0, 10, 6, 4, 7, 9, 20, 25, 7] }),
      laneChunk({ complexitySpans: [0, 3, 15, 30, 31, 2] }),
    ];
    const outputs = permutations(chunks).map((p) => JSON.stringify(buildProjectFileTree(p)));
    expect(new Set(outputs).size).toBe(1);
    const [page] = buildProjectFileTree(chunks);
    expect(page.complexitySpans).toEqual([0, 3, 12, 0, 10, 6, 4, 7, 9, 20, 25, 5, 30, 31, 2]);
  });

  it("merges the declaration lane into one kind table in pipeline order, re-indexed, deduped and sorted", () => {
    const chunks = [
      laneChunk({
        declarationKinds: ["LowerVarToLet", "DeclarationChaining"],
        declarationSpans: [6, 11, 0, 6, 11, 1, 30, 33, 0],
      }),
      laneChunk({
        declarationKinds: ["LowerFunctionDeclToArrow", "DeclarationChaining"],
        declarationSpans: [14, 19, 0, 6, 11, 1],
      }),
      laneChunk({
        declarationKinds: ["LowerVarToLet", "LowerFunctionDeclToArrow"],
        declarationSpans: [40, 44, 1, 30, 33, 0],
      }),
      laneChunk({ declarationKinds: ["UnusedBindingElimination"], declarationSpans: [] }),
    ];
    const outputs = permutations(chunks).map((p) => JSON.stringify(buildProjectFileTree(p)));
    expect(new Set(outputs).size).toBe(1);
    const [page] = buildProjectFileTree(chunks);
    expect(page.declarationKinds).toEqual([
      "LowerVarToLet",
      "LowerFunctionDeclToArrow",
      "DeclarationChaining",
    ]);
    expect(page.declarationSpans).toEqual([6, 11, 0, 6, 11, 2, 14, 19, 1, 30, 33, 0, 40, 44, 1]);

    const [empty] = buildProjectFileTree([
      laneChunk({ complexitySpans: [], declarationKinds: [], declarationSpans: [] }),
    ]);
    expect(empty.complexitySpans).toEqual([]);
    expect(empty.declarationKinds).toEqual([]);
    expect(empty.declarationSpans).toEqual([]);
  });

  it("merges maps from an engine without the new lanes byte-for-byte as before", () => {
    const entry = (
      outputSize: number,
      regions: Record<string, unknown>[],
      renamedSpans: [number, number][],
      extractedSpans: number[],
    ) => ({
      file: {
        path: "webpack://_N_E/./app/shared.tsx",
        sourceOrigin: "original",
        vendor: false,
        originalSource: "const total = price * qty;\nexport const label = total + 1;\n",
        inputSize: 57,
        bundledInputSize: 40,
        outputSize,
        outputSizeEstimated: true,
      },
      regions,
      spotlights: [{ span: [44, 45], severity: "leak", sample: "x", reason: "r" }],
      renamedSpans,
      extractedSpans,
      aggregate: { classSummary: {}, directives: [{ keyword: "skip", span: [0, 5] }] },
    });
    const scored = (span: [number, number], entropyRaw: number, reversalClass: string) => ({
      span,
      reversalClass,
      score: entropyRaw * 10,
      entropy: entropyRaw / 10,
      entropyRaw,
      transformCount: 1,
      sizeDeltaEst: 3,
      perf: { costClass: "none", decodeOps: 0, callFrames: 0 },
      lineage: [{ transform: "ScopeDeepen" }],
    });
    const chunks = [
      entry(
        90,
        [scored([6, 11], 4, "renamed-encoded"), scored([14, 19], 6, "flattened-fused")],
        [
          [6, 11],
          [14, 19],
        ],
        [14, 19, 0],
      ),
      entry(
        70,
        [scored([6, 11], 4, "renamed-encoded"), scored([33, 38], 2, "renamed-encoded")],
        [
          [33, 38],
          [6, 11],
        ],
        [22, 25, 1, 14, 19, 0],
      ),
    ];
    expect(JSON.stringify(buildProjectFileTree(chunks))).toBe(LANE_FREE_MERGE);
    expect(JSON.stringify(buildProjectFileTree([chunks[1], chunks[0]]))).toBe(LANE_FREE_MERGE);
  });

  it("keeps same-path/different-source entries separate, suffix-disambiguated + flagged", () => {
    const files = [
      original("webpack://_N_E/./app/page.tsx", "SRC_A", [], []),
      original("webpack://_N_E/./app/page.tsx", "SRC_B", [], []),
    ];
    const tree = buildProjectFileTree(files);
    expect(tree).toHaveLength(2);
    expect(tree[0].file?.path).toBe("app/page.tsx");
    expect(tree[0].file?.pathCollision).toBeUndefined();
    expect(tree[1].file?.path).toBe("app/page.tsx#2");
    expect(tree[1].file?.pathCollision).toBe(true);
  });

  it("cleanSourcePath strips every bundler URL prefix + de-pnpm-s vendor paths", () => {
    expect(cleanSourcePath("turbopack:///[project]/app/(dash)/page.tsx")).toBe(
      "app/(dash)/page.tsx",
    );
    expect(cleanSourcePath("webpack://_N_E/./components/Button.tsx")).toBe("components/Button.tsx");
    expect(cleanSourcePath("./lib/util.ts")).toBe("lib/util.ts");
    expect(cleanSourcePath("node_modules/.pnpm/react@18.3.1/node_modules/react/index.js")).toBe(
      "node_modules/react/index.js",
    );
  });

  it("isRuntimeSource flags framework/bundler runtime but not user code or vendor deps", () => {
    expect(isRuntimeSource("turbopack:///[turbopack]/browser/runtime.js")).toBe(true);
    expect(isRuntimeSource("turbopack:///[next]/dist/client/app-index.js")).toBe(true);
    expect(isRuntimeSource("webpack://_N_E/webpack/runtime/jsonp.js")).toBe(true);
    expect(
      isRuntimeSource(
        "turbopack:///[project]/node_modules/.pnpm/next@15.0.0/node_modules/next/x.js",
      ),
    ).toBe(true);
    expect(isRuntimeSource("turbopack:///[project]/app/(dash)/page.tsx")).toBe(false);
    expect(
      isRuntimeSource(
        "turbopack:///[project]/node_modules/.pnpm/lodash@4.17.21/node_modules/lodash/index.js",
      ),
    ).toBe(false);
  });
});

describe("ensureAfterpackGitignore", () => {
  it("creates .afterpack/.gitignore with the self-ignoring `*` pattern", () => {
    const afterpackDir = join(dir, ".afterpack");
    mkdirSync(afterpackDir, { recursive: true });

    ensureAfterpackGitignore(afterpackDir);

    expect(readFileSync(join(afterpackDir, ".gitignore"), "utf8")).toBe("*\n");
  });

  it("never overwrites an existing .afterpack/.gitignore", () => {
    const afterpackDir = join(dir, ".afterpack");
    mkdirSync(afterpackDir, { recursive: true });
    writeFileSync(join(afterpackDir, ".gitignore"), "custom\n");

    ensureAfterpackGitignore(afterpackDir);

    expect(readFileSync(join(afterpackDir, ".gitignore"), "utf8")).toBe("custom\n");
  });

  it("places the .gitignore at the top-level .afterpack/, even for a nested writer", () => {
    const leg = join(dir, ".afterpack", "preload");
    mkdirSync(leg, { recursive: true });

    ensureAfterpackGitignore(leg);

    expect(readFileSync(join(dir, ".afterpack", ".gitignore"), "utf8")).toBe("*\n");
    expect(existsSync(join(leg, ".gitignore"))).toBe(false);
  });

  it("never touches the user's own .gitignore anywhere in the tree", () => {
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    const afterpackDir = join(dir, ".afterpack");
    mkdirSync(afterpackDir, { recursive: true });

    ensureAfterpackGitignore(afterpackDir);

    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("node_modules/\n");
  });
});

describe("warnIfPublicPath", () => {
  it("fires for served path segments (public/static/_next/dist/...)", () => {
    for (const p of [
      join("app", "public", "main.js.map"),
      join("dist", "assets", "x.protectionMap.html"),
      join(".next", "static", "chunks", "a.js.map"),
      join("out", "_next", "b.js.map"),
    ]) {
      const cap = captureLogger();
      expect(warnIfPublicPath(p, cap.logger)).toBe(true);
      expect(cap.warns.join("")).toMatch(/served/i);
    }
  });

  it("does not fire for a private/non-served path", () => {
    const cap = captureLogger();
    expect(warnIfPublicPath(join("src", "lib", "main.js.map"), cap.logger)).toBe(false);
    expect(cap.warns).toEqual([]);
  });
});
