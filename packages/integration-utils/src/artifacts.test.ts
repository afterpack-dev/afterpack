import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { decodeCompact } from "@afterpack/protection-map";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildProjectFileTree,
  cleanSourcePath,
  ensureGitignore,
  GITIGNORE_ENTRIES,
  isRuntimeSource,
  type Logger,
  warnIfPublicPath,
  writeArtifacts,
  writeCombinedProtectionMap,
} from "./artifacts.js";
import { resolveReportPolicy } from "./policy.js";

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

function pmDoc(path: string) {
  return {
    file: { path, bytes: 10, sourceOrigin: "original" },
    source: "const x = 1;",
    regions: [],
    spotlights: [],
    aggregate: { classSummary: {} },
  };
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

  it("force-enabling PM in prod redirects it to gitignored .afterpack/ + warns loudly", () => {
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
    expect(cap.warns.join("\n")).toMatch(/PRODUCTION build/i);
    expect(cap.warns.join("\n")).toMatch(/ORIGINAL SOURCE/i);
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

  it("returns null when PM is disabled or there are no docs", () => {
    const off = resolveReportPolicy({ NODE_ENV: "production" }, {});
    expect(
      writeCombinedProtectionMap({ buildDir: dir, docs: [pmDoc("x")], policy: off }),
    ).toBeNull();
    const on = resolveReportPolicy({}, {});
    expect(writeCombinedProtectionMap({ buildDir: dir, docs: [], policy: on })).toBeNull();
  });

  it("redirects a prod-forced combined PM into .afterpack/ + warns", () => {
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
    expect(cap.warns.join("\n")).toMatch(/PRODUCTION build/i);
  });

  function v3Doc(backend: string, paths: string[]) {
    return {
      schemaVersion: 3,
      generatedAt: null,
      engine: { backend, preset: "Medium", seed: 7, version: "9.9.9" },
      files: paths.map((path) => ({
        file: { path, sourceOrigin: "original", originalSource: "const x = 1;", inputSize: 12 },
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
    expect(data.engine).toMatchObject({ backend: "core-v1", preset: "Medium", seed: 7 });
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

describe("ensureGitignore", () => {
  function repoWithGitignore(contents = ""): string {
    const repo = join(dir, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".gitignore"), contents);
    return repo;
  }

  it("adds every guard glob to the nearest .gitignore above the target, once", () => {
    const repo = repoWithGitignore();
    const target = join(repo, "dist", "assets");
    mkdirSync(target, { recursive: true });

    expect([...ensureGitignore(target)].sort()).toEqual([...GITIGNORE_ENTRIES].sort());
    const content = readFileSync(join(repo, ".gitignore"), "utf8");
    for (const entry of GITIGNORE_ENTRIES) expect(content).toContain(entry);

    expect(ensureGitignore(target)).toEqual([]);
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toBe(content);
  });

  it("only appends the MISSING entries to an existing .gitignore, preserving content", () => {
    const repo = repoWithGitignore("node_modules/\n*.map\n");
    const added = ensureGitignore(repo);
    expect(added).not.toContain("*.map");
    expect(added).toContain(".afterpack/");
    const content = readFileSync(join(repo, ".gitignore"), "utf8");
    expect(content).toContain("node_modules/");
    expect((content.match(/\*\.map/g) || []).length).toBe(1);
  });

  it("never touches the working directory's repository when the target lives outside it", () => {
    const repo = repoWithGitignore("node_modules/\n");
    const outside = join(dir, "elsewhere", "bundle");
    mkdirSync(outside, { recursive: true });
    vi.spyOn(process, "cwd").mockReturnValue(repo);

    expect(ensureGitignore(outside)).toEqual([]);
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toBe("node_modules/\n");
    expect(existsSync(join(outside, ".gitignore"))).toBe(false);
    expect(existsSync(join(dir, "elsewhere", ".gitignore"))).toBe(false);
  });

  it("stops at the repository root rather than climbing into an outer .gitignore", () => {
    writeFileSync(join(dir, ".gitignore"), "outer\n");
    const inner = join(dir, "inner");
    mkdirSync(join(inner, ".git"), { recursive: true });
    const target = join(inner, "dist");
    mkdirSync(target, { recursive: true });

    expect(ensureGitignore(target)).toEqual([]);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("outer\n");
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
