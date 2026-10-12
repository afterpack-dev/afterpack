import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { processBatch as ProcessBatch, version as Version } from "@afterpack/core";
import {
  type CoreConfig,
  type EngineBatchResult,
  type EngineFileInput,
  runObfuscationPass,
} from "@afterpack/integration-utils";
import { afterAll, describe, expect, it } from "vitest";
import { guardedEngine } from "../../../test/core-fake.js";

const { processBatch, version } = createRequire(import.meta.url)("@afterpack/core") as {
  processBatch: typeof ProcessBatch;
  version: typeof Version;
};

const root = mkdtempSync(join(tmpdir(), "afterpack-wire-roundtrip-"));
const project = join(root, "app");
const dist = join(project, "dist");

afterAll(() => rmSync(root, { recursive: true, force: true }));

const CODE = [
  "export function lookup(name) {",
  '  const table = { alpha: "first value", beta: "second value" };',
  "  return table[name] ?? name.length;",
  "}",
  "export function total(items) {",
  "  let sum = 0;",
  "  for (const item of items) sum += item.price * item.quantity;",
  "  return sum;",
  "}",
  "",
].join("\n");

function write(path: string, text: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function fixture(): { files: string[]; excluded: string } {
  write(join(project, "package.json"), '{"name":"app"}');
  write(join(project, "package-lock.json"), "{}");
  const chunk = write(join(dist, "static", "chunks", "a.js"), CODE);
  const original = `// notes: ${homedir()} and ${project}/src/notes.md\n${CODE}`;
  write(
    `${chunk}.map`,
    JSON.stringify({
      version: 3,
      file: chunk,
      sources: [join(project, "src", "a.ts")],
      sourcesContent: [original],
      names: [],
      mappings: `AACA${";AACA".repeat(CODE.split("\n").length - 2)}`,
    }),
  );
  const rooted = write(join(dist, "static", "chunks", "b.js"), CODE.replaceAll("lookup", "find"));
  write(
    `${rooted}.map`,
    JSON.stringify({
      version: 3,
      sourceRoot: `${project}/`,
      sources: ["src/b.ts"],
      sourcesContent: [CODE.replaceAll("lookup", "find")],
      names: [],
      mappings: `AAAA${";AACA".repeat(CODE.split("\n").length - 2)}`,
    }),
  );
  const plain = write(join(dist, "static", "plain", "nomap.js"), CODE.replaceAll("total", "add"));
  const excluded = write(join(dist, "static", "plain", "excluded.js"), "export const x = 1;\n");
  return { files: [join(dist, "static", "chunks", "a.js"), rooted, plain, excluded], excluded };
}

describe("relative paths on the wire, local paths in every result", () => {
  it("gives the same code, maps, Protection Map and diagnostics as an absolute-path request", async () => {
    const { files, excluded } = fixture();
    const localInputs: EngineFileInput[] = files.map((path) => {
      let sourceMap: string | undefined;
      try {
        sourceMap = readFileSync(`${path}.map`, "utf8");
      } catch {}
      return { path, source: readFileSync(path, "utf8"), ...(sourceMap ? { sourceMap } : {}) };
    });
    const sent: { inputs: EngineFileInput[]; config: CoreConfig }[] = [];
    const observed: EngineBatchResult[] = [];

    await runObfuscationPass({
      files,
      engine: guardedEngine({
        version,
        processBatch: (inputs: EngineFileInput[], config: CoreConfig, context) => {
          sent.push({ inputs, config });
          return processBatch(inputs, config, context);
        },
      }),
      label: "afterpack-test",
      cwd: project,
      env: { NODE_ENV: "development" },
      seed: 11,
      preset: "hard",
      combinedProtectionMap: { buildDir: dist },
      artifactOptions: {
        protectionMap: { enabled: true },
        sourceMap: { enabled: true },
        git: false,
      },
      engineConfig: { paths: { exclude: [excluded] }, protectionMap: { detailed: true } },
      onBatch: (_inputs, batch) => observed.push(batch),
      logger: { warn: () => {}, log: () => {} },
    });

    const wire = sent[0];
    expect(JSON.stringify(wire)).not.toContain(project);
    expect(JSON.stringify(wire)).not.toContain(homedir());
    const absolute = await processBatch(
      localInputs,
      { ...wire.config, paths: { exclude: [excluded] } },
      null,
    );
    const local = observed[0];
    expect(local.files.map((f) => f.path)).toEqual(absolute.files.map((f) => f.path));
    local.files.forEach((file, i) => {
      const before = absolute.files[i];
      expect(file.code).toBe(before.code);
      expect(file.sourceMap).toBe(before.sourceMap);
      expect(file.diagnostics).toEqual(before.diagnostics);
      expect(file.protectionMap).toEqual(before.protectionMap);
    });
    expect(wire.inputs[0].sourceMap).not.toBe(localInputs[0].sourceMap);
    const attributed = local.files[0].protectionMap?.files.find(
      (f) => f.file.path === join(project, "src", "a.ts"),
    );
    expect(attributed?.regions.length).toBeGreaterThan(0);
    expect(
      local.files.some((f) =>
        f.diagnostics?.some((d) => d.code === "DIAG_PATH_EXCLUDED" && d.message.includes(excluded)),
      ),
    ).toBe(true);
  }, 60000);
});
