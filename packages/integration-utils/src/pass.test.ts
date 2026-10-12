import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProtectionMap } from "@afterpack/protection-map";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guardedEngine } from "../../../test/core-fake.js";
import type { EngineDiagnostic } from "./diagnostics.js";
import { DIAG_ALREADY_OBFUSCATED } from "./diagnostics.js";
import type { EngineFileInput, EngineFileResult, ObfuscationEngine } from "./pass.js";
import { runObfuscationPass } from "./pass.js";
import type { BuildContext, CoreConfig } from "./policy.js";
import {
  type ProtectionReceipt,
  protectionReceiptPath,
  sha256Of,
  verifyProtectionReceipt,
} from "./receipt.js";
import { resetBuildSessions, SEED_ENV_VAR } from "./seed.js";
import { buildTelemetryPayload, type TelemetryFacts } from "./telemetry.js";

let root: string;
let outDir: string;

beforeEach(() => {
  resetBuildSessions();
  root = realpathSync(mkdtempSync(join(tmpdir(), "afterpack-pass-test-")));
  outDir = join(root, "dist");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(root, ".gitignore"), "");
  writeFileSync(join(root, "package.json"), "{}");
});
afterEach(() => {
  resetBuildSessions();
  rmSync(root, { recursive: true, force: true });
});

interface FakeResult {
  code?: string;
  sourceMap?: string | null;
  protectionMap?: ProtectionMap;
  fail?: string;
  diagnostics?: EngineDiagnostic[];
}

function makeEngine(
  impl: (source: string) => FakeResult,
  source: "local" | "cloud" | "wasm" = "local",
  version?: string,
): {
  engine: ObfuscationEngine;
  calls: { inputs: EngineFileInput[]; config: CoreConfig; buildContext?: BuildContext }[];
} {
  const calls: {
    inputs: EngineFileInput[];
    config: CoreConfig;
    buildContext?: BuildContext;
  }[] = [];
  const engine: ObfuscationEngine = guardedEngine({
    async processBatch(inputs, config, buildContext) {
      calls.push({ inputs, config, buildContext: buildContext ?? undefined });
      const files: EngineFileResult[] = inputs.map((f) => {
        const r = impl(f.source);
        if (r.fail) {
          return {
            path: f.path,
            code: "",
            status: "failure",
            error: r.fail,
            diagnostics: r.diagnostics,
          };
        }
        return {
          path: f.path,
          code: r.code ?? `OBF:${f.source}`,
          sourceMap: r.sourceMap ?? undefined,
          protectionMap: r.protectionMap ?? undefined,
          status: "success",
          diagnostics: r.diagnostics ?? [],
        };
      });
      return {
        files,
        totalFiles: files.length,
        successCount: files.filter((f) => f.status === "success").length,
        failureCount: files.filter((f) => f.status === "failure").length,
        source: source as "local" | "cloud",
      };
    },
  });
  if (version !== undefined) engine.version = async () => version;
  return { engine, calls };
}

function pmDoc(source: string, path: string): ProtectionMap {
  return {
    schemaVersion: 3,
    generatedAt: null,
    engine: { version: "0.0.0-test", backend: "t", seed: 0, preset: null, complexity: 0 },
    files: [
      {
        file: {
          path,
          originalSource: source,
          inputSize: source.length,
          outputSize: source.length,
          sourceOrigin: "original",
        },
        regions: [],
        spotlights: [],
        aggregate: {},
      },
    ],
  };
}

function silentLogger() {
  const warnings: string[] = [];
  const logs: string[] = [];
  return {
    logger: { warn: (m: string) => warnings.push(m), log: (m: string) => logs.push(m) },
    warnings,
    logs,
  };
}

function receiptFor(dir: string): string {
  return protectionReceiptPath(dir);
}

const baseOptions = (files: string[], engine: ObfuscationEngine) =>
  ({
    files,
    engine,
    label: "afterpack-test",
    cwd: root,
    env: {},
    combinedProtectionMap: { buildDir: outDir },
  }) as const;

describe("runObfuscationPass (dev policy)", () => {
  it("obfuscates in place, writes .map + sourceMappingURL + combined PM, NO backup by default, returns a result", async () => {
    const a = join(outDir, "a.js");
    const b = join(outDir, "b.mjs");
    writeFileSync(a, "export const a = 1;");
    writeFileSync(b, "export const b = 2;");
    const { engine, calls } = makeEngine((s) => ({
      sourceMap: '{"version":3,"sources":["x.ts"]}',
      protectionMap: pmDoc(s, "chunk"),
    }));

    const result = await runObfuscationPass({
      ...baseOptions([a, b], engine),
      env: { NODE_ENV: "development" },
      artifactOptions: { protectionMap: { enabled: true }, sourceMap: { emitUrl: true } },
      logger: silentLogger().logger,
    });

    expect(readFileSync(a, "utf8")).toContain("OBF:export const a = 1;");
    expect(readFileSync(a, "utf8")).toContain("//# sourceMappingURL=a.js.map");
    expect(existsSync(`${a}.map`)).toBe(true);
    expect(readdirSync(outDir).some((f) => /^a\.backup\.[0-9a-f]{8}\.js$/.test(f))).toBe(false);
    expect(result.policy.backup).toBe(false);
    expect(existsSync(join(outDir, "protectionMap.html"))).toBe(false);
    expect(existsSync(join(root, ".afterpack", "protectionMap.html"))).toBe(true);
    expect(readFileSync(join(root, ".afterpack", ".gitignore"), "utf8")).toBe("*\n");
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("");
    expect(result.fileCount).toBe(2);
    expect(result.protectionMapPath).toContain("protectionMap.html");
    expect(result.policy.protectionMap).toBe(true);
    expect((calls[0].config.protectionMap as { enabled: boolean }).enabled).toBe(true);
  });

  it("writes the original-source backup only when the caller opts in with backup:true", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "export const a = 1;");
    const { engine } = makeEngine(() => ({}));

    const result = await runObfuscationPass({
      ...baseOptions([a], engine),
      artifactOptions: { build: { backup: true } },
      logger: silentLogger().logger,
    });

    expect(result.policy.backup).toBe(true);
    expect(readdirSync(outDir).some((f) => /^a\.backup\.[0-9a-f]{8}\.js$/.test(f))).toBe(true);
  });

  it("discovers an adjacent input .map and forwards it on the FileInput (config stays AUTO)", async () => {
    const a = join(outDir, "app.js");
    writeFileSync(a, "console.log(1);");
    const upstream = '{"version":3,"sources":["app.ts"]}';
    writeFileSync(`${a}.map`, upstream);
    const { engine, calls } = makeEngine(() => ({ sourceMap: '{"version":3}' }));

    await runObfuscationPass({
      ...baseOptions([a], engine),
      env: { NODE_ENV: "development" },
      logger: silentLogger().logger,
    });

    expect(calls[0].inputs[0].sourceMap).toBe(upstream);
    expect((calls[0].config.sourceMap as { enabled?: boolean }).enabled).toBeUndefined();
  });

  it("passes the resolved seed into the shared config", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "const a = 1;");
    const { engine, calls } = makeEngine(() => ({}));
    await runObfuscationPass({
      ...baseOptions([a], engine),
      seed: 12345,
      logger: silentLogger().logger,
    });
    expect(calls[0].config.seed).toBe(12345);
  });
});

describe("runObfuscationPass (production policy)", () => {
  it("writes NO .map (prod maps-off), no sourceMappingURL comment, no PM", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "export const a = 1;");
    const { engine, calls } = makeEngine((s) => ({
      sourceMap: '{"version":3}',
      protectionMap: pmDoc(s, "x"),
    }));

    const result = await runObfuscationPass({
      ...baseOptions([a], engine),
      env: { NODE_ENV: "production" },
      logger: silentLogger().logger,
    });

    expect(existsSync(`${a}.map`)).toBe(false);
    expect(readFileSync(a, "utf8")).not.toContain("sourceMappingURL");
    expect(result.protectionMapPath).toBeNull();
    expect((calls[0].config.protectionMap as { enabled: boolean }).enabled).toBe(false);
  });
});

const BUNDLER_MAP = JSON.stringify({
  version: 3,
  sources: ["src/secret.ts"],
  sourcesContent: ["export const secret: string = 'ORIGINAL';"],
  mappings: "AAAA",
});
const ENGINE_MAP = '{"version":3,"sources":["chained.ts"],"mappings":"AAAA"}';

function inlineTrailer(json: string): string {
  return `//# sourceMappingURL=data:application/json;base64,${Buffer.from(json).toString("base64")}`;
}

describe("runObfuscationPass never ships the bundler's source map", () => {
  it("deletes the adjacent map and strips the trailer in production", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "var a=1;\n//# sourceMappingURL=a.js.map\n");
    writeFileSync(`${a}.map`, BUNDLER_MAP);
    const { engine } = makeEngine(() => ({ sourceMap: ENGINE_MAP }));

    await runObfuscationPass({
      ...baseOptions([a], engine),
      env: { NODE_ENV: "production" },
      logger: silentLogger().logger,
    });

    expect(existsSync(`${a}.map`)).toBe(false);
    expect(readFileSync(a, "utf8")).toBe("OBF:var a=1;\n");
  });

  it("deletes a differently named map the trailer points at, and a hidden map no trailer names", async () => {
    mkdirSync(join(outDir, "maps"));
    const named = join(outDir, "named.js");
    const hidden = join(outDir, "hidden.js");
    writeFileSync(named, "var n=1;\n//# sourceMappingURL=maps/named.map\n");
    writeFileSync(join(outDir, "maps", "named.map"), BUNDLER_MAP);
    writeFileSync(hidden, "var h=1;\n");
    writeFileSync(`${hidden}.map`, BUNDLER_MAP);
    const { engine } = makeEngine(() => ({}));

    await runObfuscationPass({
      ...baseOptions([named, hidden], engine),
      env: { NODE_ENV: "production" },
      logger: silentLogger().logger,
    });

    expect(readdirSync(join(outDir, "maps"))).toEqual([]);
    expect(existsSync(`${hidden}.map`)).toBe(false);
    expect(readFileSync(named, "utf8")).not.toContain("sourceMappingURL");
  });

  it("strips an inline data URI map in production", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, `var a=1;\n${inlineTrailer(BUNDLER_MAP)}\n`);
    const { engine, calls } = makeEngine(() => ({ sourceMap: ENGINE_MAP }));

    await runObfuscationPass({
      ...baseOptions([a], engine),
      env: { NODE_ENV: "production" },
      logger: silentLogger().logger,
    });

    expect(calls[0].inputs[0].sourceMap).toBe(BUNDLER_MAP);
    expect(readFileSync(a, "utf8")).toBe("OBF:var a=1;\n");
    expect(readdirSync(outDir).filter((f) => f.endsWith(".map"))).toEqual([]);
  });

  it("replaces the bundler's map with the engine's when sourceMap.enabled opts in", async () => {
    mkdirSync(join(outDir, "maps"));
    const a = join(outDir, "a.js");
    const b = join(outDir, "b.js");
    const c = join(outDir, "c.js");
    writeFileSync(a, "var a=1;\n//# sourceMappingURL=a.js.map\n");
    writeFileSync(`${a}.map`, BUNDLER_MAP);
    writeFileSync(b, `var b=1;\n${inlineTrailer(BUNDLER_MAP)}\n`);
    writeFileSync(c, "var c=1;\n//# sourceMappingURL=maps/c.map\n");
    writeFileSync(join(outDir, "maps", "c.map"), BUNDLER_MAP);
    const { engine } = makeEngine(() => ({ sourceMap: ENGINE_MAP }));

    await runObfuscationPass({
      ...baseOptions([a, b, c], engine),
      env: { NODE_ENV: "production" },
      artifactOptions: { sourceMap: { enabled: true, emitUrl: true } },
      logger: silentLogger().logger,
    });

    for (const [file, name] of [
      [a, "a.js.map"],
      [b, "b.js.map"],
      [c, "c.js.map"],
    ]) {
      expect(readFileSync(`${file}.map`, "utf8")).toBe(ENGINE_MAP);
      const code = readFileSync(file, "utf8");
      expect(code.match(/sourceMappingURL=/g)).toHaveLength(1);
      expect(code.endsWith(`//# sourceMappingURL=${name}\n`)).toBe(true);
    }
    expect(readdirSync(join(outDir, "maps"))).toEqual([]);
  });

  it("deletes the bundler's map when the engine returns none, even with sourceMap.enabled", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "var a=1;\n//# sourceMappingURL=a.js.map\n");
    writeFileSync(`${a}.map`, BUNDLER_MAP);
    const { engine } = makeEngine(() => ({}));

    await runObfuscationPass({
      ...baseOptions([a], engine),
      artifactOptions: { sourceMap: { enabled: true, emitUrl: true } },
      logger: silentLogger().logger,
    });

    expect(existsSync(`${a}.map`)).toBe(false);
    expect(readFileSync(a, "utf8")).not.toContain("sourceMappingURL");
  });

  it("leaves a map outside the build directory alone", async () => {
    const outside = join(root, "a.js.map");
    writeFileSync(outside, BUNDLER_MAP);
    const a = join(outDir, "a.js");
    writeFileSync(a, "var a=1;\n//# sourceMappingURL=../a.js.map\n");
    const { engine } = makeEngine(() => ({}));

    await runObfuscationPass({
      ...baseOptions([a], engine),
      env: { NODE_ENV: "production" },
      logger: silentLogger().logger,
    });

    expect(readFileSync(outside, "utf8")).toBe(BUNDLER_MAP);
    expect(readFileSync(a, "utf8")).toBe("OBF:var a=1;\n");
  });

  it("keeps an engine map a later file's bundler map would have named", async () => {
    const a = join(outDir, "a.js");
    const b = join(outDir, "b.js");
    writeFileSync(b, "var b=1;\n//# sourceMappingURL=b.js.map\n");
    writeFileSync(`${b}.map`, BUNDLER_MAP);
    writeFileSync(a, "var a=1;\n//# sourceMappingURL=b.js.map\n");
    const { engine } = makeEngine(() => ({ sourceMap: ENGINE_MAP }));

    await runObfuscationPass({
      ...baseOptions([b, a], engine),
      artifactOptions: { sourceMap: { enabled: true, emitUrl: true } },
      logger: silentLogger().logger,
    });

    expect(readFileSync(`${b}.map`, "utf8")).toBe(ENGINE_MAP);
    expect(readFileSync(`${a}.map`, "utf8")).toBe(ENGINE_MAP);
  });

  it("sweeps stale and differently named JS maps from the build directory, but not node_modules or a nested project", async () => {
    mkdirSync(join(outDir, "chunks"));
    mkdirSync(join(outDir, "node_modules", "dep"), { recursive: true });
    mkdirSync(join(outDir, "functions"));
    writeFileSync(join(outDir, "functions", "package.json"), "{}");
    writeFileSync(join(outDir, "functions", "index.js.map"), BUNDLER_MAP);
    const a = join(outDir, "a.js");
    writeFileSync(a, "var a=1;\n");
    for (const name of ["old-chunk.js.map", "chunks/x.mjs.map", "chunks/y.cjs.map"]) {
      writeFileSync(join(outDir, name), BUNDLER_MAP);
    }
    writeFileSync(join(outDir, "node_modules", "dep", "index.js.map"), BUNDLER_MAP);
    const { engine } = makeEngine(() => ({}));

    await runObfuscationPass({
      ...baseOptions([a], engine),
      sourceMapSweepDir: outDir,
      logger: silentLogger().logger,
    });

    expect(readdirSync(outDir).filter((f) => f.endsWith(".map"))).toEqual([]);
    expect(readdirSync(join(outDir, "chunks"))).toEqual([]);
    expect(readFileSync(join(outDir, "node_modules", "dep", "index.js.map"), "utf8")).toBe(
      BUNDLER_MAP,
    );
    expect(readFileSync(join(outDir, "functions", "index.js.map"), "utf8")).toBe(BUNDLER_MAP);
  });

  it("deletes CSS maps and their trailers in production, as the bundle plugins do", async () => {
    const a = join(outDir, "a.js");
    const css = join(outDir, "styles.css");
    writeFileSync(a, "var a=1;\n");
    writeFileSync(css, "a{}\n/*# sourceMappingURL=styles.css.map*/");
    writeFileSync(`${css}.map`, BUNDLER_MAP);
    const { engine } = makeEngine(() => ({}));

    await runObfuscationPass({
      ...baseOptions([a], engine),
      sourceMapSweepDir: outDir,
      logger: silentLogger().logger,
    });

    expect(existsSync(`${css}.map`)).toBe(false);
    expect(readFileSync(css, "utf8")).toBe("a{}\n");
  });

  it("keeps CSS maps when sourceMap.enabled opts in, as the bundle plugins do", async () => {
    const a = join(outDir, "a.js");
    const css = join(outDir, "styles.css");
    writeFileSync(a, "var a=1;\n");
    writeFileSync(css, "a{}\n/*# sourceMappingURL=styles.css.map*/");
    writeFileSync(`${css}.map`, BUNDLER_MAP);
    const { engine } = makeEngine(() => ({ sourceMap: ENGINE_MAP }));

    await runObfuscationPass({
      ...baseOptions([a], engine),
      sourceMapSweepDir: outDir,
      artifactOptions: { sourceMap: { enabled: true } },
      logger: silentLogger().logger,
    });

    expect(readFileSync(`${css}.map`, "utf8")).toBe(BUNDLER_MAP);
    expect(readFileSync(css, "utf8")).toContain("sourceMappingURL=styles.css.map");
  });

  it("never deletes through a symlinked directory that leads outside the build directory", async () => {
    const outside = join(root, "elsewhere");
    mkdirSync(outside);
    writeFileSync(join(outside, "z.js.map"), BUNDLER_MAP);
    symlinkSync(outside, join(outDir, "linked"), "dir");
    const a = join(outDir, "a.js");
    writeFileSync(a, "var a=1;\n//# sourceMappingURL=linked/z.js.map\n");
    const { engine } = makeEngine(() => ({}));

    await runObfuscationPass({
      ...baseOptions([a], engine),
      sourceMapSweepDir: outDir,
      logger: silentLogger().logger,
    });

    expect(readFileSync(join(outside, "z.js.map"), "utf8")).toBe(BUNDLER_MAP);
    expect(readFileSync(a, "utf8")).toBe("OBF:var a=1;\n");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "fails the run when a bundler map cannot be removed",
    async () => {
      const locked = join(outDir, "locked");
      mkdirSync(locked);
      writeFileSync(join(locked, "c.js.map"), BUNDLER_MAP);
      chmodSync(locked, 0o555);
      const a = join(outDir, "a.js");
      writeFileSync(a, "var a=1;\n");
      const { engine } = makeEngine(() => ({}));

      try {
        await expect(
          runObfuscationPass({
            ...baseOptions([a], engine),
            sourceMapSweepDir: outDir,
            logger: silentLogger().logger,
          }),
        ).rejects.toThrow(/could not remove the source map .*c\.js\.map, refusing to ship it/);
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );

  it("removes a symlinked map itself and never the file it points at", async () => {
    const target = join(root, "ext.map");
    writeFileSync(target, BUNDLER_MAP);
    const a = join(outDir, "a.js");
    writeFileSync(a, "var a=1;\n");
    symlinkSync(target, `${a}.map`);
    const { engine } = makeEngine(() => ({}));

    await runObfuscationPass({
      ...baseOptions([a], engine),
      sourceMapSweepDir: outDir,
      logger: silentLogger().logger,
    });

    expect(readdirSync(outDir).filter((f) => f.endsWith(".map"))).toEqual([]);
    expect(readFileSync(target, "utf8")).toBe(BUNDLER_MAP);
  });

  it("leaves JS a symlink places outside the build directory unprotected, with its map, and says so", async () => {
    const shared = join(root, "shared");
    mkdirSync(shared);
    writeFileSync(join(shared, "s.js"), "var s=1;\n//# sourceMappingURL=s.js.map\n");
    writeFileSync(join(shared, "s.js.map"), BUNDLER_MAP);
    symlinkSync(shared, join(outDir, "shared"), "dir");
    const a = join(outDir, "a.js");
    const s = join(outDir, "shared", "s.js");
    writeFileSync(a, "var a=1;\n");
    const { engine, calls } = makeEngine(() => ({}));
    const cap = silentLogger();

    await runObfuscationPass({
      ...baseOptions([a, s], engine),
      sourceMapSweepDir: outDir,
      logger: cap.logger,
    });

    expect(calls[0].inputs.map((i) => i.path)).toEqual(["a.js"]);
    expect(readFileSync(s, "utf8")).toBe("var s=1;\n//# sourceMappingURL=s.js.map\n");
    expect(readFileSync(join(shared, "s.js.map"), "utf8")).toBe(BUNDLER_MAP);
    expect(cap.warnings.some((w) => w.includes("left 1 file(s) untouched") && w.includes(s))).toBe(
      true,
    );
  });

  it("sweeps nothing unless the caller names a directory, touching only each file's own maps", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "var a=1;\n//# sourceMappingURL=a.js.map\n");
    writeFileSync(`${a}.map`, BUNDLER_MAP);
    writeFileSync(join(outDir, "other.js.map"), BUNDLER_MAP);
    const { engine } = makeEngine(() => ({}));

    await runObfuscationPass({ ...baseOptions([a], engine), logger: silentLogger().logger });

    expect(existsSync(`${a}.map`)).toBe(false);
    expect(readFileSync(join(outDir, "other.js.map"), "utf8")).toBe(BUNDLER_MAP);
  });

  it("leaves the disk alone when the caller takes the output in memory", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "var a=1;\n//# sourceMappingURL=a.js.map\n");
    writeFileSync(`${a}.map`, BUNDLER_MAP);
    const { engine } = makeEngine(() => ({}));

    await runObfuscationPass({
      ...baseOptions([a], engine),
      env: { NODE_ENV: "production" },
      emitToCaller: true,
      logger: silentLogger().logger,
    });

    expect(readFileSync(`${a}.map`, "utf8")).toBe(BUNDLER_MAP);
  });
});

describe("runObfuscationPass fail-closed", () => {
  it("throws (label-prefixed) when the engine reports a failure", async () => {
    const a = join(outDir, "bad.js");
    writeFileSync(a, "const x = 1;");
    const { engine } = makeEngine(() => ({ fail: "engine bug" }));
    await expect(
      runObfuscationPass({ ...baseOptions([a], engine), logger: silentLogger().logger }),
    ).rejects.toThrow(/\[afterpack-test\] failed to obfuscate/);
  });

  it("throws when the engine returns a path with no captured source", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "const a = 1;");
    const engine: ObfuscationEngine = guardedEngine({
      async processBatch() {
        return {
          files: [{ path: "/ghost.js", code: "x", status: "success" }],
          totalFiles: 1,
          successCount: 1,
          failureCount: 0,
          source: "local",
        };
      },
    });
    await expect(
      runObfuscationPass({ ...baseOptions([a], engine), logger: silentLogger().logger }),
    ).rejects.toThrow(/no captured source/);
  });
});

describe("runObfuscationPass fail-closed cleartext guard", () => {
  it("throws naming the file when a success comes back with empty code on non-empty source", async () => {
    const a = join(outDir, "leaky.js");
    writeFileSync(a, "export const a = 1;");
    const { engine } = makeEngine(() => ({ code: "" }));
    await expect(
      runObfuscationPass({ ...baseOptions([a], engine), logger: silentLogger().logger }),
    ).rejects.toThrow(/leaky\.js: empty output/);
  });

  it("does NOT throw on a benign no-op (code === source, non-empty output)", async () => {
    const a = join(outDir, "reexport.js");
    writeFileSync(a, "export {};");
    const { engine } = makeEngine((s) => ({ code: s }));
    const cap = silentLogger();
    const result = await runObfuscationPass({ ...baseOptions([a], engine), logger: cap.logger });
    expect(result.fileCount).toBe(1);
    expect(cap.warnings.some((w) => /could not be obfuscated/.test(w))).toBe(false);
  });
});

describe("runObfuscationPass buffer -> verify -> write", () => {
  it("writes NOTHING for any file when a LATER file comes back empty (fail closed)", async () => {
    const good = join(outDir, "good.js");
    const leaky = join(outDir, "zz-leaky.js");
    writeFileSync(good, "export const g = 1;");
    writeFileSync(leaky, "export const l = 2;");
    const { engine } = makeEngine((s) => (s.includes("l = 2") ? { code: "" } : {}));

    await expect(
      runObfuscationPass({
        ...baseOptions([good, leaky], engine),
        artifactOptions: { build: { backup: true }, protectionMap: { enabled: true } },
        logger: silentLogger().logger,
      }),
    ).rejects.toThrow(/failed to obfuscate/);

    expect(readFileSync(good, "utf8")).toBe("export const g = 1;");
    expect(readdirSync(outDir).sort()).toEqual(["good.js", "zz-leaky.js"]);
    expect(existsSync(join(root, ".afterpack", "protectionMap.html"))).toBe(false);
  });

  it("writes NOTHING when a LATER file fails outright", async () => {
    const good = join(outDir, "good.js");
    const bad = join(outDir, "zz-bad.js");
    writeFileSync(good, "export const g = 1;");
    writeFileSync(bad, "export const b = 2;");
    const { engine } = makeEngine((s) => (s.includes("b = 2") ? { fail: "engine exploded" } : {}));

    await expect(
      runObfuscationPass({
        ...baseOptions([good, bad], engine),
        artifactOptions: { build: { backup: true } },
        logger: silentLogger().logger,
      }),
    ).rejects.toThrow(/failed to obfuscate/);

    expect(readFileSync(good, "utf8")).toBe("export const g = 1;");
    expect(readdirSync(outDir).sort()).toEqual(["good.js", "zz-bad.js"]);
  });
});

describe("runObfuscationPass directive capture", () => {
  it("captures a single-file source directive when directives.enabled is true", async () => {
    const a = join(outDir, "only.js");
    writeFileSync(a, 'const s = /* @afterpack strings.encode=off */ "KEEP";\n');
    const { engine, calls } = makeEngine(() => ({}));
    await runObfuscationPass({
      ...baseOptions([a], engine),
      directivesEnabled: true,
      logger: silentLogger().logger,
    });
    const regions = calls[0].config.regions as Array<{ strings?: { encode?: boolean } }>;
    expect(regions).toHaveLength(1);
    expect(regions[0].strings?.encode).toBe(false);
  });

  it("ignores directives by default (omitted from config)", async () => {
    const a = join(outDir, "only.js");
    writeFileSync(a, 'const s = /* @afterpack strings.encode=off */ "KEEP";\n');
    const { engine, calls } = makeEngine(() => ({}));
    await runObfuscationPass({ ...baseOptions([a], engine), logger: silentLogger().logger });
    expect("regions" in calls[0].config).toBe(false);
  });
});

describe("runObfuscationPass identifiers.globals.rename scope", () => {
  const RENAME = "/* @afterpack identifiers.globals.rename */\nvar api = 1;\n";

  it("applies the flag for a ONE-file build (shared config == the authoring file)", async () => {
    const a = join(outDir, "only.js");
    writeFileSync(a, RENAME);
    const { engine, calls } = makeEngine(() => ({}));
    const cap = silentLogger();
    await runObfuscationPass({
      ...baseOptions([a], engine),
      directivesEnabled: true,
      logger: cap.logger,
    });
    expect(calls[0].config.identifiers?.globals?.rename).toBe(true);
    expect(cap.warnings.some((w) => w.includes("REFUSED"))).toBe(false);
  });

  it("REFUSES it build-wide in a multi-file build, naming the file, and warns", async () => {
    const a = join(outDir, "a.js");
    const b = join(outDir, "b.js");
    writeFileSync(a, "var plain = 1;\n");
    writeFileSync(b, RENAME);
    const { engine, calls } = makeEngine(() => ({}));
    const cap = silentLogger();

    await runObfuscationPass({
      ...baseOptions([a, b], engine),
      directivesEnabled: true,
      logger: cap.logger,
    });

    const config = calls[0].config;
    expect(
      (config.identifiers as Record<string, unknown> | undefined)?.renameGlobals,
    ).toBeUndefined();
    const refusal = cap.warnings.find((w) => w.includes("REFUSED"));
    expect(refusal).toBeDefined();
    expect(refusal).toContain(b);
    expect(refusal).toContain("all 2 file(s)");
  });

  it("REFUSES a directive recovered post-minify from a chunk's sourcesContent", async () => {
    const a = join(outDir, "chunk-abc.js");
    writeFileSync(a, PM_CHUNK);
    writeFileSync(
      `${a}.map`,
      pmMap("app.tsx", `/* @afterpack identifiers.globals.rename */\nlet v = SECRET_TOKEN;\n`),
    );
    const { engine, calls } = makeEngine(() => ({}));
    const cap = silentLogger();

    await runObfuscationPass({
      ...baseOptions([a], engine),
      directivesEnabled: true,
      postMinify: true,
      logger: cap.logger,
    });

    expect(
      (calls[0].config.identifiers as Record<string, unknown> | undefined)?.renameGlobals,
    ).toBeUndefined();
    const refusal = cap.warnings.find((w) => w.includes("REFUSED"));
    expect(refusal).toBeDefined();
    expect(refusal).toContain("app.tsx");
    expect(refusal).toContain("bundled into");
  });

  it("REFUSES it on the bundled capture path, where the module carries no region", async () => {
    const a = join(outDir, "bundle.js");
    writeFileSync(a, "var plain = 1;\n");
    const { engine, calls } = makeEngine(() => ({}));
    const cap = silentLogger();

    await runObfuscationPass({
      ...baseOptions([a], engine),
      directivesEnabled: true,
      capturedByFile: new Map([
        [a, [{ id: "./src/legacy.js", source: RENAME, directives: [], renameGlobals: true }]],
      ]),
      logger: cap.logger,
    });

    expect(
      (calls[0].config.identifiers as Record<string, unknown> | undefined)?.renameGlobals,
    ).toBeUndefined();
    const refusal = cap.warnings.find((w) => w.includes("REFUSED"));
    expect(refusal).toBeDefined();
    expect(refusal).toContain("./src/legacy.js");
    expect(refusal).toContain("bundled into");
  });
});

const PM_ORIGINAL = "let v = /* @afterpack skip */ SECRET_TOKEN;\n";
const PM_CHUNK = "let v=SECRET_TOKEN;";
const PM_MAPPINGS = "AAAA,MAA8B,aAAY";
const pmMap = (source: string, content: string) =>
  JSON.stringify({
    version: 3,
    sources: [source],
    sourcesContent: [content],
    mappings: PM_MAPPINGS,
  });

describe("runObfuscationPass post-minify (sourcesContent) directive capture", () => {
  it("scans a chunk map's sourcesContent and colors the directive onto the emitted chunk's bytes", async () => {
    const a = join(outDir, "chunk-abc.js");
    writeFileSync(a, PM_CHUNK);
    writeFileSync(`${a}.map`, pmMap("app.tsx", PM_ORIGINAL));
    const { engine, calls } = makeEngine(() => ({}));

    await runObfuscationPass({
      ...baseOptions([a], engine),
      directivesEnabled: true,
      postMinify: true,
      logger: silentLogger().logger,
    });

    const regions = calls[0].inputs[0].regions ?? [];
    expect(regions).toEqual([
      { start: 6, end: 19, complexity: 0, strings: { encode: false }, label: "skip" },
    ]);
    expect("regions" in calls[0].config).toBe(false);
  });

  it("discovers a Turbopack-style NON-adjacent map via the //# sourceMappingURL comment", async () => {
    const a = join(outDir, "0aj2r2e32eu2k.js");
    const mapName = "13e2pn4r710sy.js.map";
    writeFileSync(a, `${PM_CHUNK}\n//# sourceMappingURL=${mapName}\n`);
    writeFileSync(
      join(outDir, mapName),
      pmMap("turbopack:///[project]/pages/index.jsx", PM_ORIGINAL),
    );
    const { engine, calls } = makeEngine(() => ({}));

    await runObfuscationPass({
      ...baseOptions([a], engine),
      directivesEnabled: true,
      postMinify: true,
      logger: silentLogger().logger,
    });

    const regions = calls[0].inputs[0].regions ?? [];
    expect(regions).toHaveLength(1);
    expect(regions[0].start).toBe(6);
  });

  it("stays byte-identical (no regions) when sourcesContent carries no @afterpack directive", async () => {
    const a = join(outDir, "clean.js");
    writeFileSync(a, PM_CHUNK);
    writeFileSync(`${a}.map`, pmMap("app.tsx", "let v = SECRET_TOKEN;\n"));
    const { engine, calls } = makeEngine(() => ({}));

    await runObfuscationPass({
      ...baseOptions([a], engine),
      directivesEnabled: true,
      postMinify: true,
      logger: silentLogger().logger,
    });

    expect(calls[0].inputs[0].regions).toBeUndefined();
  });

  it("does NOT engage for the Vite pre-minify path (capturedByFile wins, sourcesContent left alone)", async () => {
    const a = join(outDir, "vite-chunk.js");
    writeFileSync(a, PM_CHUNK);
    writeFileSync(`${a}.map`, pmMap("app.tsx", PM_ORIGINAL));
    const { engine, calls } = makeEngine(() => ({}));

    await runObfuscationPass({
      ...baseOptions([a], engine),
      directivesEnabled: true,
      postMinify: true,
      capturedByFile: new Map([[join(outDir, "other.js"), []]]),
      logger: silentLogger().logger,
    });

    expect(calls[0].inputs[0].regions).toBeUndefined();
  });

  it("warns ONCE (caller message) when directives are requested but no client map has sourcesContent", async () => {
    const a = join(outDir, "no-map.js");
    writeFileSync(a, PM_CHUNK);
    const { engine } = makeEngine(() => ({}));
    const cap = silentLogger();

    await runObfuscationPass({
      ...baseOptions([a], engine),
      directivesEnabled: true,
      directivesEnabledExplicit: true,
      postMinify: true,
      messages: { directivesNeedClientMaps: "enable productionBrowserSourceMaps" },
      logger: cap.logger,
    });

    expect(cap.warnings).toContain("[afterpack-test] enable productionBrowserSourceMaps");
  });

  it("stays QUIET about missing maps when directives only came from the registry default", async () => {
    const a = join(outDir, "no-map.js");
    writeFileSync(a, PM_CHUNK);
    const { engine } = makeEngine(() => ({}));
    const cap = silentLogger();

    await runObfuscationPass({
      ...baseOptions([a], engine),
      directivesEnabled: true,
      postMinify: true,
      messages: { directivesNeedClientMaps: "enable productionBrowserSourceMaps" },
      logger: cap.logger,
    });

    expect(cap.warnings).not.toContain("[afterpack-test] enable productionBrowserSourceMaps");
  });

  it("does NOT scan sourcesContent without the postMinify opt-in (Vite default: directives on, no capturedByFile)", async () => {
    const a = join(outDir, "vite-default.js");
    writeFileSync(a, PM_CHUNK);
    writeFileSync(`${a}.map`, pmMap("app.tsx", PM_ORIGINAL));
    const { engine, calls } = makeEngine(() => ({}));

    await runObfuscationPass({
      ...baseOptions([a], engine),
      directivesEnabled: true,
      logger: silentLogger().logger,
    });

    expect(calls[0].inputs[0].regions).toBeUndefined();
  });
});

describe("runObfuscationPass diagnostics", () => {
  it("warns on the served-path guard when an artifact lands under a public segment", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "export const a = 1;");
    const { engine } = makeEngine(() => ({ sourceMap: '{"version":3}' }));
    const cap = silentLogger();
    await runObfuscationPass({
      ...baseOptions([a], engine),
      env: { NODE_ENV: "development" },
      artifactOptions: { sourceMap: { emitUrl: true } },
      logger: cap.logger,
    });
    expect(cap.warnings.some((w) => /public\/served path segment \("dist"\)/.test(w))).toBe(true);
  });

  it("warns the caller-supplied auto-enable message (label-prefixed) when PM forced without a map", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "export const a = 1;");
    const { engine } = makeEngine(() => ({}));
    const cap = silentLogger();
    await runObfuscationPass({
      ...baseOptions([a], engine),
      artifactOptions: { protectionMap: { enabled: true } },
      messages: { autoEnableBundlerSourcemap: "turn on maps" },
      logger: cap.logger,
    });
    expect(cap.warnings).toContain("[afterpack-test] turn on maps");
  });
});

describe("runObfuscationPass engine diagnostics", () => {
  const info = (code: string): EngineDiagnostic => ({
    severity: "info",
    code,
    message: `${code} fired`,
    span: null,
    file: null,
  });

  it("surfaces error diagnostics BEFORE the fail-closed throw swallows the build", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "const x = 1;");
    const { engine } = makeEngine(() => ({
      fail: "failed to parse",
      diagnostics: [
        {
          severity: "error",
          code: "DIAG_PARSE_ERROR",
          message: "failed to parse",
          span: { startByte: 12, endByte: 13 },
          file: null,
          data: { kind: "parseError", parserErrorKind: "Expected" },
        },
      ],
    }));
    const cap = silentLogger();
    await expect(
      runObfuscationPass({ ...baseOptions([a], engine), logger: cap.logger }),
    ).rejects.toThrow(/failed to obfuscate/);
    expect(cap.warnings).toContain(
      `[afterpack-test] error DIAG_PARSE_ERROR · ${a} bytes 12..13 · failed to parse · ` +
        'parserErrorKind="Expected"',
    );
  });

  it("attributes a file-less diagnostic to the file whose result carried it", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "const x = 1;");
    const { engine } = makeEngine(() => ({
      diagnostics: [
        {
          severity: "critical",
          code: "DIAG_ENGINE_BUG_PROCESS_THREAD_PANIC",
          message: "panic",
          span: null,
          file: null,
        },
      ],
    }));
    const cap = silentLogger();
    await runObfuscationPass({ ...baseOptions([a], engine), logger: cap.logger });
    expect(cap.warnings).toContain(
      `[afterpack-test] critical DIAG_ENGINE_BUG_PROCESS_THREAD_PANIC · ${a} · panic`,
    );
  });

  it("says nothing about info diagnostics at the default level, but still tallies them on the result", async () => {
    const files = ["a.js", "b.js", "c.js"].map((n) => join(outDir, n));
    for (const f of files) writeFileSync(f, "const x = 1;");
    const { engine } = makeEngine(() => ({
      diagnostics: [info("DIAG_ENGINE_PASSES"), info("DIAG_TARGET_REACHED")],
    }));
    const cap = silentLogger();
    const result = await runObfuscationPass({ ...baseOptions(files, engine), logger: cap.logger });
    expect(cap.logs.some((l) => l.includes("info diagnostic(s)"))).toBe(false);
    expect(result.diagnostics).toEqual({
      total: 6,
      info: 6,
      error: 0,
      critical: 0,
      byCode: { DIAG_ENGINE_PASSES: 3, DIAG_TARGET_REACHED: 3 },
    });

    for (const f of files) writeFileSync(f, "const x = 2;");
    const all = silentLogger();
    await runObfuscationPass({
      ...baseOptions(files, engine),
      diagnostics: "all",
      logger: all.logger,
    });
    expect(all.logs.filter((l) => l.includes("info diagnostic(s)"))).toEqual([
      "[afterpack-test] 6 info diagnostic(s): DIAG_ENGINE_PASSES x3 · DIAG_TARGET_REACHED x3",
    ]);
  });

  it("prints no progress, summary or info line at the `none` level, and still reports errors", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "const x = 1;");
    const loud: EngineDiagnostic = {
      severity: "error",
      code: "DIAG_SOMETHING_WRONG",
      message: "something went wrong",
      span: null,
      file: null,
    };
    const { engine } = makeEngine(() => ({
      diagnostics: [info("DIAG_ENGINE_PASSES"), loud],
    }));

    const chatty = silentLogger();
    await runObfuscationPass({ ...baseOptions([a], engine), logger: chatty.logger });
    expect(chatty.logs.length).toBeGreaterThan(0);

    writeFileSync(a, "const x = 1;");
    const quiet = silentLogger();
    const result = await runObfuscationPass({
      ...baseOptions([a], engine),
      diagnostics: "none",
      logger: quiet.logger,
    });
    expect(quiet.logs).toEqual([]);
    expect(quiet.warnings.some((w) => w.includes("DIAG_SOMETHING_WRONG"))).toBe(true);
    expect(result.diagnostics.total).toBe(2);
  });

  it("lists every info diagnostic at the `all` level", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "const x = 1;");
    const { engine } = makeEngine(() => ({ diagnostics: [info("DIAG_ENGINE_PASSES")] }));
    const cap = silentLogger();
    await runObfuscationPass({
      ...baseOptions([a], engine),
      diagnostics: "all",
      logger: cap.logger,
    });
    expect(cap.logs).toContain(
      `[afterpack-test] info DIAG_ENGINE_PASSES · ${a} · DIAG_ENGINE_PASSES fired`,
    );
  });

  it("stays silent, with a zero tally, when the engine reports an empty diagnostic list", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "const x = 1;");
    const { engine } = makeEngine(() => ({}));
    const cap = silentLogger();
    const result = await runObfuscationPass({ ...baseOptions([a], engine), logger: cap.logger });
    expect(cap.logs.some((l) => l.includes("diagnostic(s)"))).toBe(false);
    expect(cap.warnings.some((w) => w.includes("Pro Cloud"))).toBe(false);
    expect(result.diagnostics).toEqual({ total: 0, info: 0, error: 0, critical: 0, byCode: {} });
  });

  it("says so, rather than implying a clean build, when the cloud path returns no lane", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "const x = 1;");
    const engine: ObfuscationEngine = guardedEngine({
      async processBatch(inputs) {
        return {
          files: inputs.map((i) => ({
            path: i.path,
            code: `OBF:${i.source}`,
            status: "success",
          })),
          totalFiles: inputs.length,
          successCount: inputs.length,
          failureCount: 0,
          source: "cloud",
        };
      },
    });
    const cap = silentLogger();
    await runObfuscationPass({ ...baseOptions([a], engine), logger: cap.logger });
    expect(cap.warnings).toContain(
      "[afterpack-test] engine diagnostics are not returned on the Pro Cloud path — " +
        "this build's diagnostics were recorded server-side.",
    );
  });

  it("stays quiet about a missing lane on a local engine that simply omits it", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "const x = 1;");
    const engine: ObfuscationEngine = guardedEngine({
      async processBatch(inputs) {
        return {
          files: inputs.map((i) => ({
            path: i.path,
            code: `OBF:${i.source}`,
            status: "success",
          })),
          totalFiles: inputs.length,
          successCount: inputs.length,
          failureCount: 0,
          source: "local",
        };
      },
    });
    const cap = silentLogger();
    await runObfuscationPass({ ...baseOptions([a], engine), logger: cap.logger });
    expect(cap.warnings.some((w) => w.includes("Pro Cloud"))).toBe(false);
  });
});

describe("runObfuscationPass timing", () => {
  it("prepMs + engineMs + writeMs equals totalMs exactly", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "const a = 1;");
    const { engine } = makeEngine(() => ({}));

    const result = await runObfuscationPass({
      ...baseOptions([a], engine),
      logger: silentLogger().logger,
    });

    const { prepMs, engineMs, writeMs, totalMs } = result.timing;
    expect(prepMs).toBeGreaterThanOrEqual(0);
    expect(engineMs).toBeGreaterThanOrEqual(0);
    expect(writeMs).toBeGreaterThanOrEqual(0);
    expect(prepMs + engineMs + writeMs).toBe(totalMs);
  });

  it("cloudMs is null for a local engine and equals engineMs for a cloud engine", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "const a = 1;");

    const { engine: localEngine } = makeEngine(() => ({}), "local");
    const local = await runObfuscationPass({
      ...baseOptions([a], localEngine),
      logger: silentLogger().logger,
    });
    expect(local.timing.engineSource).toBe("local");
    expect(local.timing.cloudMs).toBeNull();

    writeFileSync(a, "const a = 2;");
    const { engine: cloudEngine } = makeEngine(() => ({}), "cloud");
    const cloud = await runObfuscationPass({
      ...baseOptions([a], cloudEngine),
      logger: silentLogger().logger,
    });
    expect(cloud.timing.engineSource).toBe("cloud");
    expect(cloud.timing.cloudMs).toBe(cloud.timing.engineMs);
  });

  it("engineSource/cloudMs stay null for a third-party engine reporting neither local nor cloud", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "const a = 1;");
    const { engine } = makeEngine(() => ({}), "wasm");

    const result = await runObfuscationPass({
      ...baseOptions([a], engine),
      logger: silentLogger().logger,
    });
    expect(result.timing.engineSource).toBeNull();
    expect(result.timing.cloudMs).toBeNull();
  });

  it("a caller-supplied startedAt anchors totalMs to include its own pre-pass work", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "const a = 1;");
    const { engine } = makeEngine(() => ({}));

    const selfTimed = await runObfuscationPass({
      ...baseOptions([a], engine),
      logger: silentLogger().logger,
    });
    expect(selfTimed.timing.callerAnchored).toBe(false);

    writeFileSync(a, "const a = 2;");
    const discoveryMs = 200;
    const anchored = await runObfuscationPass({
      ...baseOptions([a], engine),
      startedAt: Date.now() - discoveryMs,
      logger: silentLogger().logger,
    });
    expect(anchored.timing.callerAnchored).toBe(true);
    expect(anchored.timing.totalMs).toBeGreaterThanOrEqual(discoveryMs);
    expect(anchored.timing.totalMs).toBeGreaterThan(selfTimed.timing.totalMs);
  });
});

describe("runObfuscationPass telemetry", () => {
  const failing: EngineDiagnostic = {
    severity: "critical",
    code: "DIAG_ENGINE_BUG_NO_PROGRESS",
    message: "no progress",
    span: null,
    file: null,
    data: { kind: "engineBug", phase: "inflate", transform: "ScopeDeepen", nodeKind: "Call" },
  };

  function recorder() {
    const seen: (TelemetryFacts | null)[] = [];
    return { seen, report: async (f: TelemetryFacts | null) => void seen.push(f) };
  }

  it("hands the reporter this build's facts, including the engine's own version", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "const x = 1;");
    const { engine } = makeEngine(() => ({ diagnostics: [failing] }));
    const rec = recorder();
    await runObfuscationPass({
      ...baseOptions([a], engine),
      engine: { ...engine, version: async () => "0.0.10" },
      telemetry: rec.report,
      clientVersion: "0.0.10",
      env: {},
      logger: silentLogger().logger,
    });
    expect(rec.seen).toHaveLength(1);
    const facts = rec.seen[0];
    expect(facts?.label).toBe("afterpack-test");
    expect(facts?.projectRoot).toBe(root);
    expect(facts?.fileCount).toBe(1);
    expect(facts?.engineVersion).toBe("0.0.10");
    expect(facts?.clientVersion).toBe("0.0.10");
    expect(facts?.diagnostics.map((d) => d.code)).toEqual(["DIAG_ENGINE_BUG_NO_PROGRESS"]);
  });

  it("still reports on the build that THROWS — the one worth reporting", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "const x = 1;");
    const { engine } = makeEngine(() => ({ fail: "boom", diagnostics: [failing] }));
    const rec = recorder();
    await expect(
      runObfuscationPass({
        ...baseOptions([a], engine),
        telemetry: rec.report,
        env: {},
        logger: silentLogger().logger,
      }),
    ).rejects.toThrow(/failed to obfuscate/);
    expect(rec.seen).toHaveLength(1);
  });

  it("calls the reporter on a CLEAN build too, so the notice lands before any send", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "const x = 1;");
    const { engine } = makeEngine(() => ({}));
    const rec = recorder();
    await runObfuscationPass({
      ...baseOptions([a], engine),
      telemetry: rec.report,
      env: {},
      logger: silentLogger().logger,
    });
    expect(rec.seen).toHaveLength(1);
    expect(rec.seen[0]?.diagnostics).toEqual([]);
  });

  it("obeys the resolved `telemetry.enabled`", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "const x = 1;");
    const { engine } = makeEngine(() => ({ diagnostics: [failing] }));
    const rec = recorder();
    await runObfuscationPass({
      ...baseOptions([a], engine),
      artifactOptions: { telemetry: { enabled: false } },
      telemetry: rec.report,
      env: {},
      logger: silentLogger().logger,
    });
    expect(rec.seen).toEqual([]);
  });

  it("makes NO outbound request when no reporter is wired — the network is at the front door", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "const x = 1;");
    const { engine } = makeEngine(() => ({ diagnostics: [failing] }));
    const original = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched += 1;
      return new Response(null);
    }) as typeof fetch;
    try {
      await runObfuscationPass({
        ...baseOptions([a], engine),
        env: {},
        logger: silentLogger().logger,
      });
    } finally {
      globalThis.fetch = original;
    }
    expect(fetched).toBe(0);
  });
});

describe("runObfuscationPass (git context)", () => {
  const SHA = "3c332a94b80dce02cbefe6dcb641d6763e7a7aed";

  type Call = { config: CoreConfig; buildContext?: BuildContext };
  const contextOf = (calls: Call[]) => calls[0].buildContext;
  const noContextOnConfig = (calls: Call[]) => {
    expect("git" in calls[0].config).toBe(false);
    expect(JSON.stringify(calls[0].config)).not.toContain("git");
  };

  it("puts an explicitly declared commit on the build-context lane", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "const x = 1;");
    const { engine, calls } = makeEngine(() => ({}));
    await runObfuscationPass({
      ...baseOptions([a], engine),
      artifactOptions: { git: { commitSha: SHA, ref: "main" } },
      env: {},
      logger: silentLogger().logger,
    });
    expect(contextOf(calls)).toEqual({ commitSha: SHA, ref: "main" });
    noContextOnConfig(calls);
  });

  it("detects the CI provider's own env vars", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "const x = 1;");
    const { engine, calls } = makeEngine(() => ({}));
    await runObfuscationPass({
      ...baseOptions([a], engine),
      env: { GITHUB_SHA: SHA, GITHUB_REF_NAME: "release/2.0" },
      logger: silentLogger().logger,
    });
    expect(contextOf(calls)).toEqual({ commitSha: SHA, ref: "release/2.0" });
    noContextOnConfig(calls);
  });

  it("DROPS a malformed value rather than forwarding it", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "const x = 1;");
    const { engine, calls } = makeEngine(() => ({}));
    await runObfuscationPass({
      ...baseOptions([a], engine),
      env: { GITHUB_SHA: "not-a-sha", GITHUB_REF_NAME: "a branch with spaces" },
      logger: silentLogger().logger,
    });
    expect(contextOf(calls)).toBeUndefined();
    noContextOnConfig(calls);
    expect(JSON.stringify(calls[0].config)).not.toContain("not-a-sha");
  });

  it("sends NOTHING — absent, not empty — when no git context exists", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "const x = 1;");
    const { engine, calls } = makeEngine(() => ({}));
    await runObfuscationPass({
      ...baseOptions([a], engine),
      env: {},
      logger: silentLogger().logger,
    });
    expect(contextOf(calls)).toBeUndefined();
    noContextOnConfig(calls);
  });

  it("skips detection entirely on `git: false`", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "const x = 1;");
    const { engine, calls } = makeEngine(() => ({}));
    await runObfuscationPass({
      ...baseOptions([a], engine),
      artifactOptions: { git: false },
      env: { GITHUB_SHA: SHA, GITHUB_REF_NAME: "main" },
      logger: silentLogger().logger,
    });
    expect(contextOf(calls)).toBeUndefined();
    noContextOnConfig(calls);
  });

  it("NEVER lets the commit reach the anonymous telemetry lane", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "const x = 1;");
    const critical: EngineDiagnostic = {
      severity: "critical",
      code: "DIAG_ENGINE_BUG_NO_PROGRESS",
      message: "no progress",
      span: null,
      file: null,
    };
    const { engine, calls } = makeEngine(() => ({ diagnostics: [critical] }));
    const seen: (TelemetryFacts | null)[] = [];
    await runObfuscationPass({
      ...baseOptions([a], engine),
      telemetry: async (f) => void seen.push(f),
      env: { GITHUB_SHA: SHA, GITHUB_REF_NAME: "secret-branch" },
      logger: silentLogger().logger,
    });
    expect(contextOf(calls)).toEqual({ commitSha: SHA, ref: "secret-branch" });
    noContextOnConfig(calls);
    const payload = buildTelemetryPayload(seen[0] as TelemetryFacts, {
      installId: "11111111-2222-4333-8444-555555555555",
      env: {},
    });
    for (const wire of [JSON.stringify(seen[0]), JSON.stringify(payload)]) {
      expect(wire).not.toContain(SHA);
      expect(wire).not.toContain("secret-branch");
      expect(wire).not.toContain("commitSha");
    }
  });
});

describe("runObfuscationPass — the cross-bundle build seed", () => {
  async function leg(name: string, seed?: number | string) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "a.js");
    writeFileSync(file, `const ${name} = 1;`);
    const { engine, calls } = makeEngine(() => ({}));
    const captured = silentLogger();
    const result = await runObfuscationPass({
      files: [file],
      engine,
      label: `afterpack-test:${name}`,
      cwd: root,
      buildLeg: name,
      seed,
      diagnostics: "all",
      combinedProtectionMap: { buildDir: dir, subdir: name },
      logger: captured.logger,
    });
    return { result, config: calls[0].config, ...captured };
  }

  it("gives every leg of one build the SAME seed, and says where it came from", async () => {
    const main = await leg("main");
    const preload = await leg("preload");
    const renderer = await leg("renderer");
    expect(main.config.seed).toBe(preload.config.seed);
    expect(main.config.seed).toBe(renderer.config.seed);
    expect(main.result.seedOrigin).toBe("fresh");
    expect(renderer.result.seedOrigin).toBe("session");
  });

  it("re-running the SAME leg is a rebuild and draws a NEW seed", async () => {
    const first = await leg("main");
    const second = await leg("main");
    expect(second.result.seed).not.toBe(first.result.seed);
  });

  it("reports the seed and its origin on the machine-readable summary line", async () => {
    const { logs, result } = await leg("main", 12345);
    const summary = logs.find((l) => l.includes("Protected "));
    expect(summary).toContain(`· seed ${result.seed} (option)`);
  });

  it("warns when one leg pinned a seed and another did not", async () => {
    await leg("main", 12345);
    const renderer = await leg("renderer");
    expect(renderer.warnings.join("\n")).toMatch(/does not match leg "main"/);
    expect(renderer.logs.find((l) => l.includes("Protected "))).toContain("(MISMATCH)");
  });

  it("an ancestor process's AFTERPACK_SEED pins every leg (the cross-PROCESS channel)", async () => {
    process.env[SEED_ENV_VAR] = "5150";
    try {
      const main = await leg("main");
      expect(main.result).toMatchObject({ seed: 5150, seedOrigin: "env" });
    } finally {
      delete process.env[SEED_ENV_VAR];
    }
  });
});

describe("runObfuscationPass in-memory seam (inputs + emitToCaller)", () => {
  const virtual = () => join(outDir, "bundle.HASH_REF_0000.js");

  it("obfuscates a path that never existed on disk, and writes nothing beside it", async () => {
    const path = virtual();
    const { engine, calls } = makeEngine(() => ({}));

    const result = await runObfuscationPass({
      ...baseOptions([path], engine),
      inputs: new Map([[path, { source: "export const a = 1;" }]]),
      emitToCaller: true,
      logger: silentLogger().logger,
    });

    expect(calls[0].inputs[0].source).toBe("export const a = 1;");
    expect(result.outputs).toEqual([{ path, code: "OBF:export const a = 1;", sourceMap: null }]);
    expect(readdirSync(outDir)).toEqual([]);
  });

  it("uses the SUPPLIED map and never probes the sibling `.map` on disk", async () => {
    const path = join(outDir, "a.js");
    writeFileSync(path, "on-disk source");
    writeFileSync(`${path}.map`, '{"version":3,"sources":["stale.ts"],"mappings":""}');
    const { engine, calls } = makeEngine(() => ({}));

    await runObfuscationPass({
      ...baseOptions([path], engine),
      inputs: new Map([
        [path, { source: "in-memory source", sourceMap: '{"version":3,"sources":["live.ts"]}' }],
      ]),
      emitToCaller: true,
      logger: silentLogger().logger,
    });

    expect(calls[0].inputs[0].source).toBe("in-memory source");
    expect(calls[0].inputs[0].sourceMap).toContain("live.ts");
    expect(readFileSync(path, "utf8")).toBe("on-disk source");
  });

  it("treats a supplied `sourceMap: null` as 'no map', not as 'go look'", async () => {
    const path = join(outDir, "a.js");
    writeFileSync(path, "x");
    writeFileSync(`${path}.map`, '{"version":3,"sources":["stale.ts"],"mappings":""}');
    const { engine, calls } = makeEngine(() => ({}));

    await runObfuscationPass({
      ...baseOptions([path], engine),
      inputs: new Map([[path, { source: "x", sourceMap: null }]]),
      emitToCaller: true,
      logger: silentLogger().logger,
    });

    expect(calls[0].inputs[0].sourceMap).toBeUndefined();
  });

  it("still reads a path the caller did NOT supply (the two modes mix)", async () => {
    const supplied = join(outDir, "a.js");
    const onDisk = join(outDir, "b.js");
    writeFileSync(onDisk, "from disk");
    const { engine, calls } = makeEngine(() => ({}));

    await runObfuscationPass({
      ...baseOptions([supplied, onDisk], engine),
      inputs: new Map([[supplied, { source: "from memory" }]]),
      emitToCaller: true,
      logger: silentLogger().logger,
    });

    expect(calls[0].inputs.map((i) => i.source)).toEqual(["from memory", "from disk"]);
  });

  it("keeps the fail-closed gates on the in-memory path", async () => {
    const path = virtual();
    const failing = makeEngine(() => ({ fail: "engine exploded" })).engine;

    await expect(
      runObfuscationPass({
        ...baseOptions([path], failing),
        inputs: new Map([[path, { source: "export const a = 1;" }]]),
        emitToCaller: true,
        logger: silentLogger().logger,
      }),
    ).rejects.toThrow(/engine exploded/);

    const empty = makeEngine(() => ({ code: "" })).engine;
    await expect(
      runObfuscationPass({
        ...baseOptions([path], empty),
        inputs: new Map([[path, { source: "export const a = 1;" }]]),
        emitToCaller: true,
        logger: silentLogger().logger,
      }),
    ).rejects.toThrow(/failed to obfuscate/);
  });

  it("still writes the project-root artifacts: the self-ignoring .afterpack/ + the combined Protection Map", async () => {
    const path = virtual();
    const { engine } = makeEngine((s) => ({ protectionMap: pmDoc(s, "chunk") }));

    const result = await runObfuscationPass({
      ...baseOptions([path], engine),
      inputs: new Map([[path, { source: "export const a = 1;" }]]),
      emitToCaller: true,
      artifactOptions: { protectionMap: { enabled: true } },
      combinedProtectionMap: {
        buildDir: outDir,
        fileName: "one-bundle.protectionMap.html",
      },
      logger: silentLogger().logger,
    });

    expect(readFileSync(join(root, ".afterpack", ".gitignore"), "utf8")).toBe("*\n");
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("");
    expect(result.protectionMapPath).toBe(
      join(root, ".afterpack", "one-bundle.protectionMap.html"),
    );
    expect(existsSync(result.protectionMapPath as string)).toBe(true);
  });

  it("warns instead of silently dropping an explicit backup:true", async () => {
    const path = virtual();
    const { engine } = makeEngine(() => ({}));
    const captured = silentLogger();

    await runObfuscationPass({
      ...baseOptions([path], engine),
      inputs: new Map([[path, { source: "export const a = 1;" }]]),
      emitToCaller: true,
      artifactOptions: { build: { backup: true } },
      logger: captured.logger,
    });

    expect(captured.warnings.join("\n")).toContain("backup:true is not available");
    expect(readdirSync(outDir)).toEqual([]);
  });

  it("omits `outputs` entirely on the ordinary on-disk path", async () => {
    const path = join(outDir, "a.js");
    writeFileSync(path, "export const a = 1;");
    const { engine } = makeEngine(() => ({}));

    const result = await runObfuscationPass({
      ...baseOptions([path], engine),
      logger: silentLogger().logger,
    });

    expect(result.outputs).toBeUndefined();
    expect(readFileSync(path, "utf8")).toContain("OBF:");
  });
});

describe("runObfuscationPass — already-obfuscated pre-flight guard", () => {
  it("(1) refuses a re-run over its own unchanged previous output, writing nothing", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "export const a = 1;");
    const { engine } = makeEngine(() => ({}));

    await runObfuscationPass({ ...baseOptions([a], engine), logger: silentLogger().logger });
    const receiptPath = receiptFor(outDir);
    const receiptBefore = readFileSync(receiptPath, "utf8");
    const bytesBefore = readFileSync(a, "utf8");

    await expect(
      runObfuscationPass({ ...baseOptions([a], engine), logger: silentLogger().logger }),
    ).rejects.toThrow(new RegExp(DIAG_ALREADY_OBFUSCATED));

    expect(readFileSync(a, "utf8")).toBe(bytesBefore);
    expect(readFileSync(receiptPath, "utf8")).toBe(receiptBefore);
  });

  it("(2) does not refuse a genuine rebuild — new source bytes over a stale receipt", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "export const a = 1;");
    const { engine } = makeEngine(() => ({}));

    await runObfuscationPass({ ...baseOptions([a], engine), logger: silentLogger().logger });

    writeFileSync(a, "export const a = 2;");

    const result = await runObfuscationPass({
      ...baseOptions([a], engine),
      logger: silentLogger().logger,
    });
    expect(result.fileCount).toBe(1);
    expect(readFileSync(a, "utf8")).toContain("OBF:export const a = 2;");
  });

  it("(3) has no signal once the receipt is deleted — the documented detection limit", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "export const a = 1;");
    const { engine } = makeEngine(() => ({}));

    await runObfuscationPass({ ...baseOptions([a], engine), logger: silentLogger().logger });
    rmSync(receiptFor(outDir));

    const result = await runObfuscationPass({
      ...baseOptions([a], engine),
      logger: silentLogger().logger,
    });
    expect(result.fileCount).toBe(1);
    expect(readFileSync(a, "utf8")).toContain("OBF:OBF:export const a = 1;");
  });

  it("(4) a stale `.backup.<hash>` sibling from a prior run is NOT a signal", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "export const a = 1;");
    const { engine } = makeEngine(() => ({}));
    const opts = { artifactOptions: { build: { backup: true } }, logger: silentLogger().logger };

    await runObfuscationPass({ ...baseOptions([a], engine), ...opts });
    expect(readdirSync(outDir).some((f) => /\.backup\./.test(f))).toBe(true);

    writeFileSync(a, "export const a = 2;");

    const result = await runObfuscationPass({ ...baseOptions([a], engine), ...opts });
    expect(result.fileCount).toBe(1);
    expect(readFileSync(a, "utf8")).toContain("OBF:export const a = 2;");
  });

  it("(5) ignores a receipt (for an ancestor dir) naming files outside the target", async () => {
    const site = join(root, "site");
    const other = join(site, "other-app", "unrelated.js");
    mkdirSync(dirname(other), { recursive: true });
    writeFileSync(other, "export const unrelated = 1;");
    const { engine } = makeEngine(() => ({}));
    await runObfuscationPass({
      ...baseOptions([other], engine),
      combinedProtectionMap: { buildDir: site },
      logger: silentLogger().logger,
    });
    expect(existsSync(receiptFor(site))).toBe(true);

    const a = join(site, "dist", "a.js");
    mkdirSync(dirname(a), { recursive: true });
    writeFileSync(a, "export const a = 1;");

    const result = await runObfuscationPass({
      ...baseOptions([a], engine),
      combinedProtectionMap: { buildDir: join(site, "dist") },
      logger: silentLogger().logger,
    });
    expect(result.fileCount).toBe(1);
    expect(readFileSync(a, "utf8")).toContain("OBF:export const a = 1;");
  });

  it("skips the guard entirely for an in-memory (emitToCaller) caller", async () => {
    const path = join(outDir, "virtual.js");
    const { engine } = makeEngine(() => ({}));
    writeFileSync(path, "export const a = 1;");
    await runObfuscationPass({ ...baseOptions([path], engine), logger: silentLogger().logger });

    const result = await runObfuscationPass({
      ...baseOptions([path], engine),
      inputs: new Map([[path, { source: "export const a = 1;" }]]),
      emitToCaller: true,
      logger: silentLogger().logger,
    });
    expect(result.outputs).toEqual([{ path, code: "OBF:export const a = 1;", sourceMap: null }]);
  });
});

describe("runObfuscationPass — the protection receipt it writes", () => {
  function receiptIn(dir: string): ProtectionReceipt {
    return JSON.parse(readFileSync(receiptFor(dir), "utf8"));
  }

  it("names every file the pass wrote, hashed as shipped, and verifies clean", async () => {
    const a = join(outDir, "a.js");
    const nested = join(outDir, "chunks", "b.js");
    mkdirSync(dirname(nested), { recursive: true });
    writeFileSync(a, "export const a = 1;");
    writeFileSync(nested, "export const b = 2;");
    const { engine } = makeEngine(() => ({}));

    await runObfuscationPass({
      ...baseOptions([a, nested], engine),
      logger: silentLogger().logger,
    });

    expect(receiptIn(outDir).files).toEqual([
      { path: "a.js", sha256: sha256Of(a), transformed: true },
      { path: "chunks/b.js", sha256: sha256Of(nested), transformed: true },
    ]);
    expect(verifyProtectionReceipt(receiptFor(outDir), outDir).problems).toEqual([]);
  });

  it("records the pass label as the tool, the engine version, the seed and the caller's build identity", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "export const a = 1;");
    const { engine } = makeEngine(() => ({}));

    await runObfuscationPass({
      ...baseOptions([a], engine),
      engine: { ...engine, version: async () => "9.9.9-test" },
      seed: 4242,
      receipt: { bundler: "test-bundler", buildId: "build-7" },
      logger: silentLogger().logger,
    });

    expect(receiptIn(outDir)).toMatchObject({
      schema: 1,
      tool: "afterpack-test",
      engineVersion: "9.9.9-test",
      seed: "4242",
      seedOrigin: "option",
      bundler: "test-bundler",
      buildId: "build-7",
    });
  });

  it("falls back to an unknown bundler and no build id when the caller names neither", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "export const a = 1;");
    const { engine } = makeEngine(() => ({}));

    await runObfuscationPass({ ...baseOptions([a], engine), logger: silentLogger().logger });

    expect(receiptIn(outDir)).toMatchObject({ bundler: "unknown", buildId: null });
  });

  it("hashes the bytes a post-write step left behind, not the bytes the engine returned", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "export const a = 1;");
    const { engine } = makeEngine(() => ({}));

    await runObfuscationPass({
      ...baseOptions([a], engine),
      afterWrite: () => writeFileSync(a, "OBF:export const a = 1;\n// stripped\n"),
      logger: silentLogger().logger,
    });

    expect(receiptIn(outDir).files[0].sha256).toBe(sha256Of(a));
    expect(verifyProtectionReceipt(receiptFor(outDir), outDir).problems).toEqual([]);
  });

  it("writes NO receipt when the run throws — a failed build never reports a protected tree", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "export const a = 1;");
    const { engine } = makeEngine(() => ({ fail: "engine exploded" }));

    await expect(
      runObfuscationPass({ ...baseOptions([a], engine), logger: silentLogger().logger }),
    ).rejects.toThrow(/failed to obfuscate/);

    expect(existsSync(receiptFor(outDir))).toBe(false);
  });

  it("writes NO receipt for an in-memory (emitToCaller) caller — nothing of its own reached disk", async () => {
    const path = join(outDir, "virtual.js");
    const { engine } = makeEngine(() => ({}));

    await runObfuscationPass({
      ...baseOptions([path], engine),
      inputs: new Map([[path, { source: "export const a = 1;" }]]),
      emitToCaller: true,
      logger: silentLogger().logger,
    });

    expect(existsSync(receiptFor(outDir))).toBe(false);
  });

  it("writes it under the project's .afterpack/receipts/, keyed by the build dir, and nothing into the build dir", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "export const a = 1;");
    const { engine } = makeEngine(() => ({}));

    const result = await runObfuscationPass({
      ...baseOptions([a], engine),
      logger: silentLogger().logger,
    });

    expect(result.receiptPath).toBe(join(root, ".afterpack", "receipts", "dist.json"));
    expect(readdirSync(outDir)).toEqual(["a.js"]);
    expect(readFileSync(join(root, ".afterpack", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("keeps one receipt per build dir, so two builds in one project never overwrite each other", async () => {
    const client = join(root, "dist", "client");
    const server = join(root, "dist", "server");
    mkdirSync(client, { recursive: true });
    mkdirSync(server, { recursive: true });
    const a = join(client, "a.js");
    const b = join(server, "b.js");
    writeFileSync(a, "export const a = 1;");
    writeFileSync(b, "export const b = 2;");
    const { engine } = makeEngine(() => ({}));

    for (const [dir, file] of [
      [client, a],
      [server, b],
    ]) {
      await runObfuscationPass({
        ...baseOptions([file], engine),
        combinedProtectionMap: { buildDir: dir },
        logger: silentLogger().logger,
      });
    }

    expect(readdirSync(join(root, ".afterpack", "receipts")).sort()).toEqual([
      "dist%2Fclient.json",
      "dist%2Fserver.json",
    ]);
    expect(receiptIn(client).files.map((f) => f.path)).toEqual(["a.js"]);
    expect(receiptIn(server).files.map((f) => f.path)).toEqual(["b.js"]);
    expect(verifyProtectionReceipt(receiptFor(client), client).problems).toEqual([]);
    expect(verifyProtectionReceipt(receiptFor(server), server).problems).toEqual([]);
  });

  it("removes a stale receipt an earlier run left in the build dir, so it stops shipping", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "export const a = 1;");
    writeFileSync(join(outDir, ".afterpack-protection.json"), "{}");
    const { engine } = makeEngine(() => ({}));

    await runObfuscationPass({ ...baseOptions([a], engine), logger: silentLogger().logger });

    expect(readdirSync(outDir)).toEqual(["a.js"]);
    expect(existsSync(receiptFor(outDir))).toBe(true);
  });

  it("removes a stale receipt from the build dir for an in-memory (emitToCaller) caller too", async () => {
    const path = join(outDir, "virtual.js");
    writeFileSync(join(outDir, ".afterpack-protection.json"), "{}");
    const { engine } = makeEngine(() => ({}));

    await runObfuscationPass({
      ...baseOptions([path], engine),
      inputs: new Map([[path, { source: "export const a = 1;" }]]),
      emitToCaller: true,
      logger: silentLogger().logger,
    });

    expect(readdirSync(outDir)).toEqual([]);
  });

  it("fails the run when the stale receipt in the build dir cannot be removed", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "export const a = 1;");
    mkdirSync(join(outDir, ".afterpack-protection.json"));
    const { engine } = makeEngine(() => ({}));

    await expect(
      runObfuscationPass({ ...baseOptions([a], engine), logger: silentLogger().logger }),
    ).rejects.toThrow(/could not remove the stale protection receipt/);
    expect(readFileSync(a, "utf8")).toBe("export const a = 1;");
  });

  it("removes stale receipts throughout the tree it sweeps", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "export const a = 1;");
    mkdirSync(join(outDir, "assets"));
    writeFileSync(join(outDir, "assets", ".afterpack-protection.json"), "{}");
    const { engine } = makeEngine(() => ({}));

    await runObfuscationPass({
      ...baseOptions([a], engine),
      sourceMapSweepDir: outDir,
      logger: silentLogger().logger,
    });

    expect(readdirSync(join(outDir, "assets"))).toEqual([]);
  });

  it("fails the run, leaving the output untouched, on a .afterpack/ dir inside the build dir", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "export const a = 1;");
    mkdirSync(join(outDir, ".afterpack", "backup"), { recursive: true });
    const { engine, calls } = makeEngine(() => ({}));

    await expect(
      runObfuscationPass({ ...baseOptions([a], engine), logger: silentLogger().logger }),
    ).rejects.toThrow(/found .*\.afterpack inside the build output .*Delete .*, then build again/);
    expect(readFileSync(a, "utf8")).toBe("export const a = 1;");
    expect(calls).toHaveLength(0);
  });

  it("fails before rewriting any file when the receipt cannot be written", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "export const a = 1;");
    mkdirSync(join(root, ".afterpack"), { recursive: true });
    writeFileSync(join(root, ".afterpack", "receipts"), "not a directory");
    const { engine, calls } = makeEngine(() => ({}));

    await expect(
      runObfuscationPass({ ...baseOptions([a], engine), logger: silentLogger().logger }),
    ).rejects.toThrow(/cannot write the protection receipt .*so no file was rewritten/);
    expect(readFileSync(a, "utf8")).toBe("export const a = 1;");
    expect(calls).toHaveLength(0);
  });

  it("merges a single-file run into the dir's receipt, so a/b/a is still refused", async () => {
    const a = join(outDir, "a.js");
    const b = join(outDir, "b.js");
    writeFileSync(a, "export const a = 1;");
    writeFileSync(b, "export const b = 2;");
    const { engine } = makeEngine(() => ({}));
    const fileRun = (file: string) =>
      runObfuscationPass({
        ...baseOptions([file], engine),
        combinedProtectionMap: { buildDir: outDir, fileTarget: true },
        logger: silentLogger().logger,
      });

    await fileRun(a);
    await fileRun(b);
    expect(receiptIn(outDir).files.map((f) => f.path)).toEqual(["a.js", "b.js"]);
    await expect(fileRun(a)).rejects.toThrow(new RegExp(DIAG_ALREADY_OBFUSCATED));
    expect(verifyProtectionReceipt(receiptFor(outDir), outDir).problems).toEqual([]);
  });

  it("leaves the output sweep to the caller that asks for none", async () => {
    const a = join(outDir, "a.js");
    writeFileSync(a, "export const a = 1;");
    writeFileSync(join(outDir, ".afterpack-protection.json"), "{}");
    const { engine } = makeEngine(() => ({}));

    await runObfuscationPass({
      ...baseOptions([a], engine),
      outputSweep: false,
      logger: silentLogger().logger,
    });

    expect(existsSync(join(outDir, ".afterpack-protection.json"))).toBe(true);
  });

  it("keeps a single file's receipt in its own project when the file sits in the project root", async () => {
    writeFileSync(join(root, "package-lock.json"), "{}");
    const a = join(root, "app.js");
    writeFileSync(a, "export const a = 1;");
    const { engine } = makeEngine(() => ({}));

    const result = await runObfuscationPass({
      ...baseOptions([a], engine),
      combinedProtectionMap: { buildDir: root, fileTarget: true },
      logger: silentLogger().logger,
    });

    expect(result.receiptPath).toBe(join(root, ".afterpack", "receipts", "..json"));
    await expect(
      runObfuscationPass({
        ...baseOptions([a], engine),
        combinedProtectionMap: { buildDir: root, fileTarget: true },
        logger: silentLogger().logger,
      }),
    ).rejects.toThrow(new RegExp(DIAG_ALREADY_OBFUSCATED));
  });

  it("keeps everything beside a build dir with no project marker above it, and says where", async () => {
    rmSync(join(root, "package.json"));
    const served = join(root, "public");
    mkdirSync(served);
    const a = join(served, "a.js");
    writeFileSync(a, "export const a = 1;");
    const { engine } = makeEngine(() => ({}));
    const captured = silentLogger();

    const result = await runObfuscationPass({
      ...baseOptions([a], engine),
      combinedProtectionMap: { buildDir: served },
      logger: captured.logger,
    });

    expect(result.receiptPath).toBe(join(root, ".afterpack", "receipts", "public.json"));
    expect(readdirSync(served)).toEqual(["a.js"]);
    expect(captured.logs.join("\n")).toContain(
      `no lockfile, afterpack.json, .git or package.json above ${served}, so AfterPack keeps ` +
        `its files beside it, in ${join(root, ".afterpack")}`,
    );
  });

  it("replaces the previous run's receipt rather than merging into it", async () => {
    const a = join(outDir, "a.js");
    const b = join(outDir, "b.js");
    writeFileSync(a, "export const a = 1;");
    writeFileSync(b, "export const b = 2;");
    const { engine } = makeEngine(() => ({}));

    await runObfuscationPass({ ...baseOptions([a, b], engine), logger: silentLogger().logger });
    expect(receiptIn(outDir).files.map((f) => f.path)).toEqual(["a.js", "b.js"]);

    writeFileSync(a, "export const a = 2;");
    rmSync(b);
    await runObfuscationPass({ ...baseOptions([a], engine), logger: silentLogger().logger });

    expect(receiptIn(outDir).files.map((f) => f.path)).toEqual(["a.js"]);
    expect(verifyProtectionReceipt(receiptFor(outDir), outDir).problems).toEqual([]);
  });
});

describe("sourceType", () => {
  async function configSentWith(input: {
    version?: string;
    client?: { coreVersion: string | null } | null;
    sourceType?: "auto" | "module" | "script";
    engineConfig?: { sourceType?: "auto" | "module" | "script" };
  }): Promise<CoreConfig> {
    const a = join(outDir, "a.js");
    writeFileSync(a, "export const a = 1;");
    const { engine, calls } = makeEngine(() => ({}), "local", input.version);
    await runObfuscationPass({
      ...baseOptions([a], engine),
      sourceType: input.sourceType,
      engineConfig: input.engineConfig,
      client: input.client as never,
      logger: silentLogger().logger,
    });
    return calls[0].config;
  }

  it("sends a derived sourceType when the engine reports 0.2.3 or newer", async () => {
    const config = await configSentWith({ version: "0.2.3", sourceType: "module" });
    expect(config.sourceType).toBe("module");
  });

  it("drops a derived sourceType when the engine is older than 0.2.3", async () => {
    const config = await configSentWith({ version: "0.2.2", sourceType: "module" });
    expect(config.sourceType).toBeUndefined();
  });

  it("drops a derived sourceType when no version can be read", async () => {
    const config = await configSentWith({ sourceType: "module" });
    expect(config.sourceType).toBeUndefined();
  });

  it("falls back to the client core version when the engine does not report one", async () => {
    const config = await configSentWith({
      client: { coreVersion: "0.2.3" },
      sourceType: "module",
    });
    expect(config.sourceType).toBe("module");
  });

  it("passes an explicitly configured sourceType through regardless of engine version", async () => {
    const config = await configSentWith({
      version: "0.2.2",
      engineConfig: { sourceType: "script" },
    });
    expect(config.sourceType).toBe("script");
  });
});
