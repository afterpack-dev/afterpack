import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectJsFiles, runObfuscationPass } from "@afterpack/integration-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __reset, engineCalls, processBatch } from "../../../test/core-fake.js";

const PM_ORIGINAL = "let v = /* @afterpack skip */ SECRET_TOKEN;\n";
const PM_CHUNK = "let v=SECRET_TOKEN;";
const PM_MAPPINGS = "AAAA,MAA8B,aAAY";
const SKIP_COLORS_CHUNK_BYTES = { start: 6, end: 19 };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "afterpack-next-directives-test-"));
  __reset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("afterpack-next post-minify directive capture (the original survives only in sourcesContent)", () => {
  it("colors a chunk's sourcesContent directive onto its emitted bytes, following sourceMappingURL to a Turbopack map whose name differs from the chunk's", async () => {
    const chunks = join(dir, ".next", "static", "chunks");
    mkdirSync(chunks, { recursive: true });
    const chunkName = "0aj2r2e32eu2k.js";
    const mapNameDiffersFromChunk = "13e2pn4r710sy.js.map";
    writeFileSync(
      join(chunks, chunkName),
      `${PM_CHUNK}\n//# sourceMappingURL=${mapNameDiffersFromChunk}\n`,
    );
    writeFileSync(
      join(chunks, mapNameDiffersFromChunk),
      JSON.stringify({
        version: 3,
        sources: ["turbopack:///[project]/pages/index.jsx"],
        sourcesContent: [PM_ORIGINAL],
        mappings: PM_MAPPINGS,
      }),
    );

    const targets = collectJsFiles(chunks);
    expect(targets).toEqual([join(chunks, chunkName)]);

    await runObfuscationPass({
      files: targets,
      engine: { processBatch },
      label: "afterpack-next",
      gitignoreDir: dir,
      combinedProtectionMap: { buildDir: join(dir, ".next") },
      directivesEnabled: true,
      postMinify: true,
    });

    const call = engineCalls.find((c) => c.input.startsWith(PM_CHUNK));
    expect(call?.regions, "the directive rode the per-file regions channel").toBeDefined();
    expect(call?.regions ?? []).toEqual([
      { ...SKIP_COLORS_CHUNK_BYTES, target: 0, floor: false, label: "skip" },
    ]);
  });

  it("leaves the build byte-identical (no regions) when directives are not enabled", async () => {
    const chunks = join(dir, ".next", "static", "chunks");
    mkdirSync(chunks, { recursive: true });
    writeFileSync(join(chunks, "chunk.js"), `${PM_CHUNK}\n//# sourceMappingURL=chunk.js.map\n`);
    writeFileSync(
      join(chunks, "chunk.js.map"),
      JSON.stringify({
        version: 3,
        sources: ["a.tsx"],
        sourcesContent: [PM_ORIGINAL],
        mappings: PM_MAPPINGS,
      }),
    );

    await runObfuscationPass({
      files: collectJsFiles(chunks),
      engine: { processBatch },
      label: "afterpack-next",
      gitignoreDir: dir,
      combinedProtectionMap: { buildDir: join(dir, ".next") },
    });

    const call = engineCalls.find((c) => c.input.startsWith(PM_CHUNK));
    expect(call?.regions).toBeUndefined();
  });
});
