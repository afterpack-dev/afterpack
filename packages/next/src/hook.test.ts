import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ProtectionReceipt,
  sha256Of,
  verifyProtectionReceipt,
} from "@afterpack/integration-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __reset, __setProcessResult, engineCalls, processBatch } from "../../../test/core-fake.js";
import { nextChunkToken, runAfterpackHook, stripServedSourceMaps } from "./hook.js";

const BUILD_ID = "test-build-id";
const engine = { processBatch, version: async () => "9.9.9-test" };
const env: NodeJS.ProcessEnv = { AFTERPACK_telemetry_enabled: "false" };

let root: string;

interface Project {
  projectDir: string;
  distDir: string;
  chunksDir: string;
}

function projectAsNextLeavesItAtHookTime(bundler: "turbopack" | "webpack" = "turbopack"): Project {
  const projectDir = mkdtempSync(join(root, "app-"));
  const distDir = join(projectDir, ".next");
  const chunksDir = join(distDir, "static", "chunks");
  mkdirSync(chunksDir, { recursive: true });
  writeFileSync(
    join(distDir, "build-manifest.json"),
    JSON.stringify({ lowPriorityFiles: [`static/${BUILD_ID}/_buildManifest.js`] }),
  );
  if (bundler === "turbopack") {
    writeFileSync(join(distDir, "turbopack"), "");
  } else {
    mkdirSync(join(distDir, "server"), { recursive: true });
    writeFileSync(join(distDir, "server", "webpack-runtime.js"), "var r=1;");
  }
  return { projectDir, distDir, chunksDir };
}

const project = projectAsNextLeavesItAtHookTime;

function chunk(p: Project, name: string, source: string): string {
  const path = join(p.chunksDir, name);
  writeFileSync(path, source);
  return path;
}

function receiptPathOf(p: Project): string {
  return join(p.projectDir, ".afterpack", "receipts", ".next.json");
}

function receiptOf(p: Project): ProtectionReceipt {
  return JSON.parse(readFileSync(receiptPathOf(p), "utf8"));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "afterpack-next-hook-"));
  __reset();
  __setProcessResult((input) => ({ code: `OBF:${input}`, sourceMap: null, protectionMap: null }));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("runAfterpackHook", () => {
  it("obfuscates every client chunk under distDir/static/chunks", async () => {
    const p = project();
    const a = chunk(p, "main.js", "export const a = 1;");
    const b = chunk(p, "vendor.js", "export const b = 2;");

    await runAfterpackHook({ metadata: p, options: {}, engine, env });

    expect(readFileSync(a, "utf8")).toContain("OBF:export const a = 1;");
    expect(readFileSync(b, "utf8")).toContain("OBF:export const b = 2;");
  });

  it("REFUSES experimental.sri rather than silently invalidating every integrity hash", async () => {
    const p = project();
    chunk(p, "main.js", "export const a = 1;");

    await expect(
      runAfterpackHook({ metadata: p, options: {}, sriAlgorithm: "sha256", engine, env }),
    ).rejects.toThrow(/experimental\.sri` is not compatible/);
    expect(engineCalls).toHaveLength(0);
  });

  it("REFUSES sri it finds in the build output even when the wrapped config hid it", async () => {
    const p = project();
    chunk(p, "main.js", "export const a = 1;");
    mkdirSync(join(p.distDir, "server"), { recursive: true });
    writeFileSync(join(p.distDir, "server", "subresource-integrity-manifest.json"), "{}");

    await expect(runAfterpackHook({ metadata: p, options: {}, engine, env })).rejects.toThrow(
      /experimental\.sri` is not compatible/,
    );
    expect(engineCalls).toHaveLength(0);
  });

  it("fails the build when there is no client JS, rather than reporting a protected tree", async () => {
    const p = project();

    await expect(runAfterpackHook({ metadata: p, options: {}, engine, env })).rejects.toThrow(
      /no client JS found/,
    );
    expect(existsSync(receiptPathOf(p))).toBe(false);
  });

  it("skips on build.autorun=false, from the options object or the environment", async () => {
    const a = project();
    chunk(a, "main.js", "export const a = 1;");
    await runAfterpackHook({ metadata: a, options: { build: { autorun: false } }, engine, env });

    const b = project();
    chunk(b, "main.js", "export const a = 1;");
    await runAfterpackHook({
      metadata: b,
      options: {},
      engine,
      env: { ...env, AFTERPACK_build_autorun: "false" },
    });

    expect(engineCalls).toHaveLength(0);
    expect(existsSync(receiptPathOf(a))).toBe(false);
  });
});

describe("the protection receipt", () => {
  it("lives in the project's .afterpack/receipts/, never in .next/", async () => {
    const p = project();
    chunk(p, "main.js", "export const a = 1;");
    writeFileSync(join(p.distDir, ".afterpack-protection.json"), "{}");

    await runAfterpackHook({ metadata: p, options: {}, engine, env });

    expect(existsSync(receiptPathOf(p))).toBe(true);
    expect(existsSync(join(p.distDir, ".afterpack-protection.json"))).toBe(false);
  });

  it("keys a custom distDir by its own name", async () => {
    const p = project();
    const custom = { ...p, distDir: join(p.projectDir, ".next-webpack") };
    mkdirSync(join(custom.distDir, "static", "chunks"), { recursive: true });
    writeFileSync(join(custom.distDir, "static", "chunks", "main.js"), "export const a = 1;");

    await runAfterpackHook({ metadata: custom, options: {}, engine, env });

    expect(existsSync(join(p.projectDir, ".afterpack", "receipts", ".next-webpack.json"))).toBe(
      true,
    );
  });

  it("records the engine, seed, bundler, the build id from build-manifest.json (no BUILD_ID file yet) and a sha256 per obfuscated file", async () => {
    const p = project();
    const main = chunk(p, "main.js", "export const a = 1;");

    await runAfterpackHook({ metadata: p, options: { seed: 4242 }, engine, env });

    const receipt = receiptOf(p);
    expect(receipt).toMatchObject({
      schema: 1,
      tool: "afterpack-next",
      engineVersion: "9.9.9-test",
      seed: "4242",
      bundler: "turbopack",
      buildId: BUILD_ID,
    });
    expect(
      receipt.files,
      "hashed after the whole pass, so the receipt describes shipped bytes",
    ).toEqual([{ path: "static/chunks/main.js", sha256: sha256Of(main), transformed: true }]);
  });

  it("names the webpack bundler when webpack produced the tree", async () => {
    const p = project("webpack");
    chunk(p, "main.js", "export const a = 1;");

    await runAfterpackHook({ metadata: p, options: {}, engine, env });

    expect(receiptOf(p).bundler).toBe("webpack");
  });

  it("verifies clean straight after the build, and catches a chunk replaced afterwards", async () => {
    const p = project();
    const main = chunk(p, "main.js", "export const a = 1;");

    await runAfterpackHook({ metadata: p, options: {}, engine, env });
    expect(verifyProtectionReceipt(receiptPathOf(p), p.distDir, BUILD_ID).problems).toEqual([]);

    writeFileSync(main, "export const a = 1;");
    expect(verifyProtectionReceipt(receiptPathOf(p), p.distDir, BUILD_ID).problems).toEqual([
      "static/chunks/main.js: content changed since it was obfuscated",
    ]);
  });

  it("catches a receipt left over from an earlier build of the same tree", async () => {
    const p = project();
    chunk(p, "main.js", "export const a = 1;");

    await runAfterpackHook({ metadata: p, options: {}, engine, env });

    expect(verifyProtectionReceipt(receiptPathOf(p), p.distDir, "a-later-build").problems).toEqual([
      expect.stringContaining("rebuilt without the AfterPack wrapper"),
    ]);
  });
});

describe("stripServedSourceMaps", () => {
  it("deletes every served .js.map and strips the now-dangling trailer", () => {
    const p = project();
    const main = chunk(p, "main.js", "var a=1;\n//# sourceMappingURL=main.js.map\n");
    writeFileSync(join(p.chunksDir, "main.js.map"), '{"version":3}');
    mkdirSync(join(p.chunksDir, "app"), { recursive: true });
    const nested = join(p.chunksDir, "app", "page.js");
    writeFileSync(nested, "var b=2;");
    writeFileSync(join(p.chunksDir, "app", "page.js.map"), '{"version":3}');

    stripServedSourceMaps([main, nested], join(p.distDir, "static"));

    expect(existsSync(join(p.chunksDir, "main.js.map"))).toBe(false);
    expect(existsSync(join(p.chunksDir, "app", "page.js.map"))).toBe(false);
    expect(readFileSync(main, "utf8")).toBe("var a=1;\n");
    expect(readFileSync(nested, "utf8")).toBe("var b=2;");
  });

  it("deletes the CSS maps both bundlers serve and the trailers that name them", () => {
    const p = project();
    const turbopackCss = chunk(p, "0nltecp1q_s1s.css", "a{}\n/*# sourceMappingURL=0kdic.css.map*/");
    writeFileSync(join(p.chunksDir, "0kdic.css.map"), '{"version":3,"sourcesContent":["a{}"]}');
    const cssDir = join(p.distDir, "static", "css");
    mkdirSync(cssDir, { recursive: true });
    const webpackCss = join(cssDir, "bd1f.css");
    writeFileSync(webpackCss, "b{}\n/*# sourceMappingURL=bd1f.css.map*/");
    writeFileSync(join(cssDir, "bd1f.css.map"), '{"version":3,"sourcesContent":["b{}"]}');
    const lines: string[] = [];

    stripServedSourceMaps([], join(p.distDir, "static"), (line) => lines.push(line));

    expect(existsSync(join(p.chunksDir, "0kdic.css.map"))).toBe(false);
    expect(existsSync(join(cssDir, "bd1f.css.map"))).toBe(false);
    expect(readFileSync(turbopackCss, "utf8")).toBe("a{}\n");
    expect(readFileSync(webpackCss, "utf8")).toBe("b{}\n");
    expect(lines).toEqual([
      "[afterpack-next] stripped 2 served source map(s) + 2 sourceMappingURL trailer(s) from the client tree",
    ]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "fails the build when a served map cannot be removed",
    () => {
      const p = project();
      const locked = join(p.chunksDir, "locked");
      mkdirSync(locked, { recursive: true });
      writeFileSync(join(locked, "a.js.map"), '{"version":3}');
      chmodSync(locked, 0o555);
      try {
        expect(() => stripServedSourceMaps([], join(p.distDir, "static"))).toThrow(
          /\[afterpack-next\] could not remove the source map .*a\.js\.map, refusing to ship it/,
        );
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );

  it("is a no-op (no throw) when there are no served maps", () => {
    const p = project();
    const main = chunk(p, "main.js", "var a=1;");

    expect(() => stripServedSourceMaps([main], join(p.distDir, "static"))).not.toThrow();
    expect(readFileSync(main, "utf8")).toBe("var a=1;");
  });
});

describe("runAfterpackHook leaves no source map in the served tree", () => {
  it("strips a CSS map outside static/chunks, where webpack writes CSS", async () => {
    const p = project("webpack");
    chunk(p, "main.js", "var a=1;\n//# sourceMappingURL=main.js.map\n");
    writeFileSync(join(p.chunksDir, "main.js.map"), '{"version":3}');
    const cssDir = join(p.distDir, "static", "css");
    mkdirSync(cssDir, { recursive: true });
    writeFileSync(join(cssDir, "app.css"), "a{}\n/*# sourceMappingURL=app.css.map*/");
    writeFileSync(join(cssDir, "app.css.map"), '{"version":3}');

    await runAfterpackHook({ metadata: p, options: {}, engine, env });

    expect(existsSync(join(p.chunksDir, "main.js.map"))).toBe(false);
    expect(existsSync(join(cssDir, "app.css.map"))).toBe(false);
    expect(readFileSync(join(cssDir, "app.css"), "utf8")).toBe("a{}\n");
  });
});

describe("nextChunkToken", () => {
  it.each([
    ["static/chunks/0ssskeo7ttkz9.js", "0ssskeo7ttkz9"],
    ["static/chunks/turbopack-0gz~.xyt2domn.js", "0gz~.xyt2domn"],
    ["static/chunks/0o4l8u3~tr0.~.js", "0o4l8u3~tr0.~"],
    ["static/chunks/0ddmp~g0xqrjw.css", "0ddmp~g0xqrjw"],
    ["static/media/favicon.0x3dzn~oxb6tn.ico", null],
    ["server/chunks/[root-of-the-server]__0w9fu3o._.js", null],
  ])("reads Turbopack's content hash from %s", (path, token) => {
    expect(nextChunkToken("turbopack")(path)).toBe(token);
  });

  it.each([
    ["static/chunks/framework-145f8a2c2c53ff84.js", "145f8a2c2c53ff84"],
    ["static/chunks/283.721f6d989c3698cc.js", "721f6d989c3698cc"],
    ["static/chunks/app/page-0640c022b49868e7.js", "0640c022b49868e7"],
    ["static/chunks/4bd1b696-3f86fc20d5681851.js", "3f86fc20d5681851"],
    ["static/css/bd1f1db08a054734.css", null],
    ["static/chunks/main.js", null],
  ])("reads webpack's content hash from %s", (path, token) => {
    expect(nextChunkToken("webpack")(path)).toBe(token);
  });

  it("reads nothing from a build it cannot identify", () => {
    expect(nextChunkToken("unknown")("static/chunks/0ssskeo7ttkz9.js")).toBeNull();
  });
});

describe("runAfterpackHook content-hashed names", () => {
  it("renames each Turbopack chunk and rewrites every manifest, page and payload that names it", async () => {
    const p = project("turbopack");
    chunk(p, "0ssskeo7ttkz9.js", "self.load('static/chunks/0hkn0q5mfwmcp.js');");
    chunk(p, "0hkn0q5mfwmcp.js", "var lazy=1;\n//# sourceMappingURL=0-76~-rwsrjmv.js.map\n");
    writeFileSync(join(p.chunksDir, "0-76~-rwsrjmv.js.map"), '{"version":3}');
    writeFileSync(join(p.chunksDir, "0ddmp~g0xqrjw.css"), "a{}");
    writeFileSync(
      join(p.distDir, "build-manifest.json"),
      JSON.stringify({
        rootMainFiles: ["static/chunks/0ssskeo7ttkz9.js"],
        lowPriorityFiles: [`static/${BUILD_ID}/_buildManifest.js`],
      }),
    );
    mkdirSync(join(p.distDir, "server", "app"), { recursive: true });
    writeFileSync(
      join(p.distDir, "server", "app", "index.rsc"),
      '1:I[1,["static/chunks/0hkn0q5mfwmcp.js"],"default"]\nT2a,static/chunks/0ddmp~g0xqrjw.css',
    );
    mkdirSync(join(p.distDir, "cache"), { recursive: true });
    writeFileSync(join(p.distDir, "cache", "entry.json"), "static/chunks/0ssskeo7ttkz9.js");

    await runAfterpackHook({ metadata: p, options: { seed: 7 }, engine, env });

    const names = readdirSync(p.chunksDir).sort();
    expect(names).not.toContain("0ssskeo7ttkz9.js");
    expect(names).not.toContain("0hkn0q5mfwmcp.js");
    expect(names).toContain("0ddmp~g0xqrjw.css");
    expect(names).not.toContain("0-76~-rwsrjmv.js.map");
    const js = names.filter((name) => name.endsWith(".js"));
    expect(js).toHaveLength(2);
    for (const name of js) expect(name).toMatch(/^[0-9a-z]{13}\.js$/);
    const manifest = JSON.parse(readFileSync(join(p.distDir, "build-manifest.json"), "utf8"));
    expect(js).toContain(manifest.rootMainFiles[0].replace("static/chunks/", ""));
    const lazy = js.find(
      (name) => name !== manifest.rootMainFiles[0].replace("static/chunks/", ""),
    );
    expect(readFileSync(join(p.chunksDir, manifest.rootMainFiles[0].slice(14)), "utf8")).toBe(
      `OBF:self.load('static/chunks/${lazy}');`,
    );
    expect(readFileSync(join(p.chunksDir, lazy as string), "utf8")).toBe("OBF:var lazy=1;\n");
    expect(readFileSync(join(p.distDir, "server", "app", "index.rsc"), "utf8")).toBe(
      `1:I[1,["static/chunks/${lazy}"],"default"]\nT2a,static/chunks/0ddmp~g0xqrjw.css`,
    );
    expect(readFileSync(join(p.distDir, "cache", "entry.json"), "utf8")).toBe(
      "static/chunks/0ssskeo7ttkz9.js",
    );
    expect(
      receiptOf(p)
        .files.map((file) => file.path)
        .sort(),
    ).toEqual(js.map((name) => `static/chunks/${name}`).sort());
    expect(verifyProtectionReceipt(receiptPathOf(p), p.distDir, BUILD_ID).problems).toEqual([]);
  });

  it("rewrites the hash map in webpack's runtime chunk along with the file names", async () => {
    const p = project("webpack");
    chunk(p, "webpack-36948fbfdf1f73c0.js", 'r.u=e=>""+e+"."+{283:"721f6d989c3698cc"}[e]+".js";');
    chunk(p, "283.721f6d989c3698cc.js", "var lazy=1;");
    chunk(p, "main.js", "var entry=1;");

    await runAfterpackHook({ metadata: p, options: { seed: 7 }, engine, env });

    const names = readdirSync(p.chunksDir).sort();
    expect(names).toContain("main.js");
    const runtime = names.find((name) => name.startsWith("webpack-")) as string;
    const lazy = names.find((name) => name.startsWith("283.")) as string;
    expect(runtime).toMatch(/^webpack-[0-9a-f]{16}\.js$/);
    expect(runtime).not.toBe("webpack-36948fbfdf1f73c0.js");
    expect(lazy).toMatch(/^283\.[0-9a-f]{16}\.js$/);
    expect(lazy).not.toBe("283.721f6d989c3698cc.js");
    const lazyToken = lazy.slice(4, 20);
    expect(readFileSync(join(p.chunksDir, runtime), "utf8")).toBe(
      `OBF:r.u=e=>""+e+"."+{283:"${lazyToken}"}[e]+".js";`,
    );
  });

  it("gives the same name to the same bytes, and new names to a new seed", async () => {
    const names = async (seed: number): Promise<string[]> => {
      const p = project("webpack");
      chunk(p, "283.721f6d989c3698cc.js", "var lazy=1;");
      await runAfterpackHook({ metadata: p, options: { seed }, engine, env });
      return readdirSync(p.chunksDir);
    };
    const first = await names(1);
    expect(await names(1)).toEqual(first);
    expect(await names(2)).not.toEqual(first);
  });
});
