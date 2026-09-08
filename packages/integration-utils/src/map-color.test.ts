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
    region: { start: 0, end: 0, floor: false },
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
    expect(regions[0]).toMatchObject({ start: 0, end: KEEP_LEN, floor: false });
  });

  it("preserves the full delta (only/deny/target) on the colored region", () => {
    const d = directive();
    d.region = { start: 0, end: 0, target: 0, deny: ["integerBytecode"] };
    const mod: CapturedModule = { id: "/project/src/mod.ts", source: SOURCE, directives: [d] };
    const [r] = colorRegions(CHUNK, { sources: ["src/mod.ts"], mappings: MAPPINGS }, [mod]);
    expect(r).toMatchObject({ start: 0, end: KEEP_LEN, target: 0, deny: ["integerBytecode"] });
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
