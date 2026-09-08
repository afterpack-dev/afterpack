import { mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CapturedModule, scanDirectives } from "@afterpack/integration-utils";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import { colorRegions } from "../../integration-utils/src/map-color.js";

const SOURCE = [
  "export function hot(a) {",
  '  let out = "s";',
  "  /* @afterpack skip */",
  '  for (let i = 0; i < a; i++) out += "REGION_INSIDE_MARKER" + i;',
  "  /* @afterpack end */",
  "  return out;",
  "}",
  "export function cold() {",
  '  return "REGION_OUTSIDE_MARKER";',
  "}",
  "console.log(hot(3), cold());",
].join("\n");

describe("backward-coloring through a real Vite build", () => {
  it("colors a directive onto the minified chunk bytes it governs (comments stripped)", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ap-backcolor-")));
    const entry = join(dir, "entry.js");
    writeFileSync(entry, SOURCE);

    await build({
      root: dir,
      logLevel: "silent",
      build: {
        outDir: join(dir, "dist"),
        sourcemap: true,
        minify: "esbuild",
        lib: { entry, formats: ["es"], fileName: () => "out.js" },
      },
    });

    const distDir = join(dir, "dist");
    const jsName = readdirSync(distDir).find((f) => f.endsWith(".js"));
    expect(jsName, "an emitted .js chunk").toBeTruthy();
    const chunk = readFileSync(join(distDir, jsName as string), "utf8");
    const map = JSON.parse(readFileSync(join(distDir, `${jsName}.map`), "utf8"));

    expect(chunk, "the bundler stripped the directive comments").not.toContain("@afterpack");
    expect(chunk).toContain("REGION_INSIDE_MARKER");
    expect(chunk).toContain("REGION_OUTSIDE_MARKER");

    const scan = scanDirectives(SOURCE);
    expect(scan.directives).toHaveLength(1);
    const mod: CapturedModule = { id: entry, source: SOURCE, directives: scan.directives };
    const regions = colorRegions(chunk, { sources: map.sources, mappings: map.mappings }, [mod]);
    expect(regions.length, "the directive colored to >=1 chunk range").toBeGreaterThan(0);

    const coveredText = regions.map((r) => chunk.slice(r.start, r.end)).join(" ");
    expect(coveredText, "colored bytes cover the in-region marker only").toContain(
      "REGION_INSIDE_MARKER",
    );
    expect(coveredText).not.toContain("REGION_OUTSIDE_MARKER");
    for (const r of regions) {
      expect(r.start).toBeGreaterThanOrEqual(0);
      expect(r.end).toBeLessThanOrEqual(Buffer.byteLength(chunk, "utf8"));
      expect(r.end).toBeGreaterThan(r.start);
    }
  }, 30_000);
});
