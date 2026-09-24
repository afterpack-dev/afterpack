import { encode } from "@jridgewell/sourcemap-codec";
import { describe, expect, it } from "vitest";
import type { CapturedDirective } from "./directives.js";
import { type CapturedModule, colorRegions } from "./map-color.js";

const SOURCE = 'const keep = "AAA";\nconst drop = "BBB";';
const CHUNK = 'const keep="AAA";const drop="BBB";';
const KEEP_LEN = 'const keep="AAA";'.length;

function directive(): CapturedDirective {
  return {
    keyword: "floor",
    form: "block",
    tier: "amplifying",
    line: 1,
    column: 1,
    region: { start: 0, end: 0, strings: { encode: false } },
    charStart: 0,
    charEnd: SOURCE.indexOf("\n"),
  };
}

const MAPPINGS = encode([
  [
    [0, 0, 0, 0],
    [KEEP_LEN, 0, 1, 0],
  ],
]);

describe("colorRegions (backward-coloring)", () => {
  it("colors an original directive onto the correct minified chunk bytes", () => {
    const mod: CapturedModule = {
      id: "/project/src/mod.ts",
      source: SOURCE,
      directives: [directive()],
    };
    const regions = colorRegions(CHUNK, { sources: ["src/mod.ts"], mappings: MAPPINGS }, [mod]);
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({ start: 0, end: KEEP_LEN, strings: { encode: false } });
  });

  it("preserves the full delta (complexity and transforms) on the colored region", () => {
    const d = directive();
    d.region = { start: 0, end: 0, complexity: 0, transforms: { deny: ["integerBytecode"] } };
    const mod: CapturedModule = { id: "/project/src/mod.ts", source: SOURCE, directives: [d] };
    const [r] = colorRegions(CHUNK, { sources: ["src/mod.ts"], mappings: MAPPINGS }, [mod]);
    expect(r).toMatchObject({
      start: 0,
      end: KEEP_LEN,
      complexity: 0,
      transforms: { deny: ["integerBytecode"] },
    });
  });

  it("skips (emits no region) when there is no map, and says so", () => {
    const mod: CapturedModule = {
      id: "/project/src/mod.ts",
      source: SOURCE,
      directives: [directive()],
    };
    const warnings: string[] = [];
    expect(colorRegions(CHUNK, null, [mod], (m) => warnings.push(m))).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("DIAG_DIRECTIVE_COVERAGE_UNVERIFIED");
  });

  it("reports a module the chunk map does not list instead of dropping it", () => {
    const mod: CapturedModule = {
      id: "/project/src/absent.ts",
      source: SOURCE,
      directives: [directive()],
    };
    const warnings: string[] = [];
    const regions = colorRegions(
      CHUNK,
      { sources: ["src/other.ts"], mappings: MAPPINGS },
      [mod],
      (m) => warnings.push(m),
    );
    expect(regions).toEqual([]);
    expect(warnings.some((w) => w.includes("DIAG_DIRECTIVE_COVERAGE_UNVERIFIED"))).toBe(true);
    expect(warnings.some((w) => w.includes("/project/src/absent.ts"))).toBe(true);
  });

  it("reports a located module that colored ZERO ranges", () => {
    const d = directive();
    d.charStart = SOURCE.length;
    d.charEnd = SOURCE.length;
    const mod: CapturedModule = { id: "/project/src/mod.ts", source: SOURCE, directives: [d] };
    const warnings: string[] = [];
    const regions = colorRegions(
      CHUNK,
      { sources: ["src/mod.ts"], mappings: MAPPINGS },
      [mod],
      (m) => warnings.push(m),
    );
    expect(regions).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("DIAG_DIRECTIVE_TARGET_ELIMINATED");
  });

  it("reports a source with NO mapping segment anywhere as unresolved, not tree-shaken", () => {
    const d = directive();
    const mod: CapturedModule = { id: "/project/src/entry.ts", source: SOURCE, directives: [d] };
    const warnings: string[] = [];
    const regions = colorRegions(
      CHUNK,
      { sources: ["src/other.ts", "src/entry.ts"], mappings: MAPPINGS },
      [mod],
      (m) => warnings.push(m),
    );
    expect(regions).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("DIAG_DIRECTIVE_SOURCE_UNRESOLVED");
    expect(warnings[0]).toContain("/project/src/entry.ts");
    expect(warnings[0]).not.toContain("tree-shaken");
  });

  it("colors multi-byte chunk bytes exactly as the pre-fast-path encoder did", () => {
    const source = 'const grüß = "héllo 🌍";\nconst 中文 = "世界 ✓";\nconst plain = 1;';
    const chunk = 'const grüß="héllo 🌍";const 中文="世界 ✓";\nconst plain=1;';
    const firstEnd = source.indexOf("\n");
    const secondEnd = source.indexOf("\n", firstEnd + 1);
    const spans: [number, number][] = [
      [0, firstEnd],
      [firstEnd + 1, secondEnd],
      [secondEnd + 1, source.length],
    ];
    const mod: CapturedModule = {
      id: "/project/src/mod.ts",
      source,
      directives: spans.map(([charStart, charEnd]) => ({
        ...directive(),
        charStart,
        charEnd,
      })),
    };
    const mappings = encode([
      [
        [0, 0, 0, 0],
        ['const grüß="héllo 🌍";'.length, 0, 1, 0],
      ],
      [[0, 0, 2, 0]],
    ]);

    const warnings: string[] = [];
    const regions = colorRegions(chunk, { sources: ["src/mod.ts"], mappings }, [mod], (m) =>
      warnings.push(m),
    );

    expect(warnings).toEqual([]);
    expect(regions.map((r) => [r.start, r.end])).toEqual([
      [0, 27],
      [27, 53],
      [54, 68],
    ]);
    expect(Buffer.byteLength(chunk)).toBe(68);
  });

  it("emits nothing — and warns nothing — for a module with no directives", () => {
    const mod: CapturedModule = { id: "/project/src/mod.ts", source: SOURCE, directives: [] };
    const warnings: string[] = [];
    const regions = colorRegions(
      CHUNK,
      { sources: ["src/mod.ts"], mappings: MAPPINGS },
      [mod],
      (m) => warnings.push(m),
    );
    expect(regions).toEqual([]);
    expect(warnings).toEqual([]);
  });
});
