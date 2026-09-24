import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rollup } from "rollup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __reset, __setProcessResult, engineCalls } from "../../../test/core-fake.js";
import { afterpackRollup } from "./index.js";

const PRELUDE_HOISTED_AHEAD_OF_ENTRY =
  'export const PRELUDE = "PRELUDE_MARKER_PADDING_PADDING_PADDING_PADDING";\n';
const ENTRY = [
  'import { PRELUDE } from "./prelude.js";',
  "export function hot(a) {",
  "  let out = PRELUDE;",
  "  /* @afterpack skip */",
  '  for (let i = 0; i < a; i++) out += "REGION_INSIDE_MARKER" + i;',
  "  /* @afterpack end */",
  "  return out;",
  "}",
  'export const cold = "REGION_OUTSIDE_MARKER";',
  "console.log(hot(3), cold);",
].join("\n");

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "afterpack-rollup-backcolor-"));
  __reset();
  vi.spyOn(process, "cwd").mockReturnValue(root);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  __setProcessResult((input) => ({ code: input, sourceMap: null, protectionMap: null }));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeProject(): string {
  const entry = join(root, "entry.js");
  writeFileSync(join(root, "prelude.js"), PRELUDE_HOISTED_AHEAD_OF_ENTRY);
  writeFileSync(entry, ENTRY);
  return entry;
}

describe("directive capture through a real Rollup build", () => {
  it("colors a directive onto the emitted chunk bytes it governs", async () => {
    const bundle = await rollup({ input: writeProject(), plugins: [afterpackRollup({})] });
    await bundle.write({ dir: join(root, "dist"), format: "es", sourcemap: true });
    await bundle.close();

    expect(engineCalls).toHaveLength(1);
    const chunk = engineCalls[0].input;
    expect(chunk).toContain("REGION_INSIDE_MARKER");
    expect(chunk).toContain("REGION_OUTSIDE_MARKER");

    const regions = engineCalls[0].regions as Array<{
      start: number;
      end: number;
      target?: number;
      floor?: boolean;
    }>;
    expect(regions.length, "the directive colored to >=1 chunk range").toBeGreaterThan(0);

    const coveredBytesAsAsciiText = regions.map((r) => chunk.slice(r.start, r.end)).join(" ");
    expect(coveredBytesAsAsciiText).toContain("REGION_INSIDE_MARKER");
    expect(coveredBytesAsAsciiText).not.toContain("REGION_OUTSIDE_MARKER");
    expect(coveredBytesAsAsciiText).not.toContain("PRELUDE_MARKER");
    expect(
      regions[0].start,
      "hoisted prelude shifted the region off its original source offset, proving real coloring rather than a source-span passthrough",
    ).toBeGreaterThan(ENTRY.indexOf("@afterpack skip"));
    for (const r of regions) {
      expect(r.end).toBeLessThanOrEqual(Buffer.byteLength(chunk, "utf8"));
      expect(r.end).toBeGreaterThan(r.start);
      expect(r).toMatchObject({ target: 0, floor: false });
    }
  }, 30_000);

  it("says so (never silently) when the build emits no source map to color through", async () => {
    const bundle = await rollup({ input: writeProject(), plugins: [afterpackRollup({})] });
    await bundle.write({ dir: join(root, "dist"), format: "es", sourcemap: false });
    await bundle.close();

    expect(engineCalls[0].regions).toBeUndefined();
    const warned = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));
    expect(warned.some((w) => /no source map/i.test(w))).toBe(true);
  }, 30_000);
});
