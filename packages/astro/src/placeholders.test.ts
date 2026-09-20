import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ASTRO_POST_BUILD_PLACEHOLDERS,
  assertPlaceholdersPinned,
  findAstroPlaceholders,
} from "./placeholders.js";

describe("assertPlaceholdersPinned", () => {
  it("does not throw when every found placeholder is pinned", () => {
    expect(() => assertPlaceholdersPinned([...ASTRO_POST_BUILD_PLACEHOLDERS])).not.toThrow();
  });

  it("throws naming any placeholder that is not pinned", () => {
    expect(() => assertPlaceholdersPinned(["@@ASTRO_MANIFEST_REPLACE@@", "@@ASTRO-NEW@@"])).toThrow(
      "@@ASTRO-NEW@@",
    );
  });
});

describe("findAstroPlaceholders", () => {
  it("collects @@ASTRO..@@ and $$server-islands..$$ literals from js files, ignoring the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "afterpack-astro-"));
    const nested = join(dir, "core");
    mkdirSync(nested);
    writeFileSync(
      join(dir, "a.js"),
      'const m = "@@ASTRO_MANIFEST_REPLACE@@"; const s = "$$server-islands-map$$";',
    );
    writeFileSync(join(nested, "b.mjs"), 'export const NEW = "@@ASTRO-FUTURE@@";');
    writeFileSync(join(dir, "c.txt"), "@@ASTRO-IGNORED@@");
    writeFileSync(join(dir, "d.js"), "const noPlaceholders = 1;");

    expect(new Set(findAstroPlaceholders(dir))).toEqual(
      new Set(["@@ASTRO_MANIFEST_REPLACE@@", "$$server-islands-map$$", "@@ASTRO-FUTURE@@"]),
    );
  });

  it("returns an empty list for a directory that does not exist", () => {
    expect(findAstroPlaceholders(join(tmpdir(), "afterpack-astro-missing-xyz-987"))).toEqual([]);
  });
});
