import {
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __reset, __setProcessResult, engineCalls, processBatch } from "../../../test/core-fake.js";
import { run } from "../src/run.js";

let root: string;
let buildDir: string;
let out: string[];
let err: string[];

const logger = {
  log: (m: string) => out.push(m),
  error: (m: string) => err.push(m),
  warn: () => {},
};

function invoke(argv: string[]): Promise<number> {
  return run({ argv, cwd: root, engine: { processBatch }, logger, version: "9.9.9" });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "afterpack-cli-test-"));
  buildDir = join(root, "dist");
  mkdirSync(buildDir, { recursive: true });
  out = [];
  err = [];
  __reset();
  __setProcessResult((input) => ({ code: `OBF:${input}`, sourceMap: null, protectionMap: null }));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("run", () => {
  it("collects every emitted JS (recursively), delegates to the engine, and backs it up OUTSIDE the tree", async () => {
    writeFileSync(join(buildDir, "app.js"), "export const a = 1;");
    mkdirSync(join(buildDir, "chunks"));
    writeFileSync(join(buildDir, "chunks", "vendor.mjs"), "export const b = 2;");
    writeFileSync(join(buildDir, "styles.css"), ".x{}");

    const code = await invoke(["dist", "--protectionMap.enabled=false"]);

    expect(code).toBe(0);
    expect(readFileSync(join(buildDir, "app.js"), "utf8")).toContain("OBF:export const a = 1;");
    expect(readFileSync(join(buildDir, "chunks", "vendor.mjs"), "utf8")).toContain(
      "OBF:export const b = 2;",
    );
    expect(readFileSync(join(buildDir, "styles.css"), "utf8")).toBe(".x{}");
    expect(readdirSync(buildDir).some((f) => /\.backup\./.test(f))).toBe(false);
    expect(readFileSync(join(root, ".afterpack", "backup", "dist", "app.js"), "utf8")).toBe(
      "export const a = 1;",
    );
    expect(engineCalls.map((c) => c.input).sort()).toEqual([
      "export const a = 1;",
      "export const b = 2;",
    ]);
  });

  it("respects --build.backup=false (no backup written anywhere)", async () => {
    writeFileSync(join(buildDir, "app.js"), "export const a = 1;");
    const code = await invoke(["dist", "--build.backup=false", "--protectionMap.enabled=false"]);
    expect(code).toBe(0);
    expect(readdirSync(buildDir).some((f) => /\.backup\./.test(f))).toBe(false);
    expect(existsSync(join(root, ".afterpack", "backup"))).toBe(false);
  });

  it("backup is ON by default: --build.backup is redundant but still honoured explicitly", async () => {
    writeFileSync(join(buildDir, "app.js"), "export const a = 1;");
    const code = await invoke(["dist", "--build.backup", "--protectionMap.enabled=false"]);
    expect(code).toBe(0);
    expect(readdirSync(buildDir).some((f) => /\.backup\./.test(f))).toBe(false);
    expect(readFileSync(join(root, ".afterpack", "backup", "dist", "app.js"), "utf8")).toBe(
      "export const a = 1;",
    );
  });

  it("prints the new success block: the summary line, the receipt line and the next hint", async () => {
    writeFileSync(join(buildDir, "app.js"), "export const a = 1;");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ devDependencies: { vite: "^8.0.0" } }),
    );

    expect(await invoke(["dist", "--protectionMap.enabled=false"])).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("Protected 1 file");
    expect(text).toContain("receipt  dist/.afterpack-protection.json");
    expect(text).toContain("next  afterpack verify   before you deploy");
    expect(text).not.toContain("detected Vite");
  });

  it("prints help and version and exits 0 without touching the engine", async () => {
    expect(await invoke(["--help"])).toBe(0);
    expect(out.join("\n")).toContain("usage: afterpack");
    out = [];
    expect(await invoke(["--version"])).toBe(0);
    expect(out.join("\n")).toBe("9.9.9");
    expect(engineCalls.length).toBe(0);
  });

  it("exits nonzero (never throwing) when the engine reports a failure — fail-closed", async () => {
    writeFileSync(join(buildDir, "app.js"), "export const a = 1;");
    __setProcessResult(() => ({ code: "", diagnostics: [{ severity: "error", message: "boom" }] }));
    const code = await invoke(["dist", "--protectionMap.enabled=false"]);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("✗");
    expect(readFileSync(join(buildDir, "app.js"), "utf8")).toBe("export const a = 1;");
  });

  it("prints the failing engine diagnostic — code, locator and data — before failing closed", async () => {
    writeFileSync(join(buildDir, "app.js"), "export const a = 1;");
    const warnings: string[] = [];
    __setProcessResult(() => ({
      code: "",
      diagnostics: [
        {
          severity: "error",
          code: "DIAG_PARSE_ERROR",
          message: "failed to parse chunk",
          span: { startByte: 4, endByte: 5 },
          file: null,
          data: { kind: "parseError", parserErrorKind: "Expected" },
        },
      ],
    }));
    const code = await run({
      argv: ["dist", "--protectionMap.enabled=false"],
      cwd: root,
      engine: { processBatch },
      logger: { ...logger, warn: (m: string) => warnings.push(m) },
      version: "9.9.9",
    });
    expect(code).toBe(1);
    expect(warnings).toContain(
      `[afterpack] error DIAG_PARSE_ERROR · ${join(buildDir, "app.js")} bytes 4..5 · ` +
        'failed to parse chunk · parserErrorKind="Expected"',
    );
  });

  it("rolls info diagnostics up to one line, and --diagnostics.level=all expands them", async () => {
    writeFileSync(join(buildDir, "app.js"), "export const a = 1;");
    __setProcessResult((input) => ({
      code: `OBF:${input}`,
      diagnostics: [
        {
          severity: "info",
          code: "DIAG_ENGINE_PASSES",
          message: "4 passes",
          span: null,
          file: null,
        },
        {
          severity: "info",
          code: "DIAG_TARGET_REACHED",
          message: "target reached",
          span: null,
          file: null,
        },
      ],
    }));

    expect(await invoke(["dist", "--protectionMap.enabled=false"])).toBe(0);
    expect(out.some((l) => l.includes("info diagnostic(s)"))).toBe(false);
    expect(out.some((l) => l.includes("info DIAG_ENGINE_PASSES ·"))).toBe(false);

    out = [];
    writeFileSync(join(buildDir, "app.js"), "export const a = 1;");
    expect(await invoke(["dist", "--protectionMap.enabled=false", "--diagnostics.level=all"])).toBe(
      0,
    );
    expect(out).toContain(
      "[afterpack] 2 info diagnostic(s): DIAG_ENGINE_PASSES x1 · DIAG_TARGET_REACHED x1",
    );
    expect(out).toContain(
      `[afterpack] info DIAG_ENGINE_PASSES · ${join(buildDir, "app.js")} · 4 passes`,
    );
  });

  it("exits nonzero on a usage error, a missing path, and an empty build dir", async () => {
    expect(await invoke([])).toBe(1);
    expect(await invoke(["does-not-exist"])).toBe(1);
    expect(await invoke(["dist"])).toBe(1);
    expect(err.join("\n")).toContain("✗");
  });
});

describe("run — the Pro key reaches the engine from every documented channel", () => {
  function invokeWithEnv(argv: string[], env: Record<string, string | undefined>) {
    return run({ argv, cwd: root, engine: { processBatch }, logger, version: "9.9.9", env });
  }

  it("forwards --key= onto the variable the engine reads", async () => {
    const env: Record<string, string | undefined> = {};
    writeFileSync(join(buildDir, "app.js"), "export const a = 1;");
    expect(await invokeWithEnv(["dist", "--key=ap_live_cli"], env)).toBe(0);
    expect(env.AFTERPACK_KEY).toBe("ap_live_cli");
  });

  it("forwards the lower-case variable twin, which was inert while AFTERPACK_SEED's twin worked", async () => {
    const env: Record<string, string | undefined> = { AFTERPACK_key: "ap_live_lower" };
    writeFileSync(join(buildDir, "app.js"), "export const a = 1;");
    expect(await invokeWithEnv(["dist"], env)).toBe(0);
    expect(env.AFTERPACK_KEY).toBe("ap_live_lower");
  });

  it("sets nothing when no channel supplied a key, so a Free build stays Free", async () => {
    const env: Record<string, string | undefined> = {};
    writeFileSync(join(buildDir, "app.js"), "export const a = 1;");
    expect(await invokeWithEnv(["dist"], env)).toBe(0);
    expect(env.AFTERPACK_KEY).toBeUndefined();
  });

  it("never prints the key", async () => {
    writeFileSync(join(buildDir, "app.js"), "export const a = 1;");
    await invokeWithEnv(["dist", "--key=ap_live_secret"], {});
    expect([...out, ...err].join("\n")).not.toContain("ap_live_secret");
  });
});

describe("run — the Pro upsell line is suppressed whenever a key resolves from ANY layer", () => {
  function invokeTTY(argv: string[], env: Record<string, string | undefined> = {}) {
    return run({
      argv,
      cwd: root,
      engine: { processBatch },
      logger,
      version: "9.9.9",
      env,
      stdout: { isTTY: true, write: () => {} },
    });
  }

  it("shows the pro line on an interactive Free build with no key anywhere", async () => {
    writeFileSync(join(buildDir, "app.js"), "export const a = 1;");
    expect(await invokeTTY(["dist", "--protectionMap.enabled=false"])).toBe(0);
    expect(out.join("\n")).toContain("10 MB/month free");
  });

  it("suppresses it when the key comes from --key", async () => {
    writeFileSync(join(buildDir, "app.js"), "export const a = 1;");
    expect(await invokeTTY(["dist", "--protectionMap.enabled=false", "--key=ap_live_cli"])).toBe(0);
    expect(out.join("\n")).not.toContain("10 MB/month free");
  });

  it("suppresses it when the key comes from afterpack.json", async () => {
    writeFileSync(join(buildDir, "app.js"), "export const a = 1;");
    writeFileSync(join(root, "afterpack.json"), JSON.stringify({ key: "ap_live_file" }));
    expect(await invokeTTY(["dist", "--protectionMap.enabled=false"])).toBe(0);
    expect(out.join("\n")).not.toContain("10 MB/month free");
  });

  it("suppresses it when the key comes from the environment", async () => {
    writeFileSync(join(buildDir, "app.js"), "export const a = 1;");
    expect(
      await invokeTTY(["dist", "--protectionMap.enabled=false"], { AFTERPACK_KEY: "ap_live_env" }),
    ).toBe(0);
    expect(out.join("\n")).not.toContain("10 MB/month free");
  });

  it("still suppresses it in CI even with no key at all", async () => {
    writeFileSync(join(buildDir, "app.js"), "export const a = 1;");
    expect(await invokeTTY(["dist", "--protectionMap.enabled=false"], { CI: "true" })).toBe(0);
    expect(out.join("\n")).not.toContain("10 MB/month free");
  });
});

describe("run — a single FILE target", () => {
  it("obfuscates one plain-JS file in place and touches nothing beside it", async () => {
    const file = join(root, "app.js");
    writeFileSync(file, "var a = 1;");
    writeFileSync(join(root, "untouched.js"), "var b = 2;");

    const code = await invoke(["app.js", "--protectionMap.enabled=false"]);

    expect(code).toBe(0);
    expect(readFileSync(file, "utf8")).toContain("OBF:var a = 1;");
    expect(readFileSync(join(root, "untouched.js"), "utf8")).toBe("var b = 2;");
    expect(engineCalls.map((c) => c.input)).toEqual(["var a = 1;"]);
  });

  it("accepts .mjs/.cjs and an ABSOLUTE path", async () => {
    const mjs = join(buildDir, "esm.mjs");
    writeFileSync(mjs, "export const a = 1;");
    expect(await invoke([mjs, "--protectionMap.enabled=false"])).toBe(0);
    expect(readFileSync(mjs, "utf8")).toContain("OBF:export const a = 1;");

    const cjs = join(buildDir, "old.cjs");
    writeFileSync(cjs, "module.exports = 1;");
    expect(await invoke([join("dist", "old.cjs"), "--protectionMap.enabled=false"])).toBe(0);
    expect(readFileSync(cjs, "utf8")).toContain("OBF:module.exports = 1;");
  });

  it("exits 1 with a file-specific message on a non-JS file, never throwing", async () => {
    writeFileSync(join(root, "styles.css"), ".x{}");
    expect(await invoke(["styles.css", "--protectionMap.enabled=false"])).toBe(1);
    expect(err.join("\n")).toContain("not an obfuscatable .js/.mjs/.cjs file: styles.css");
    expect(engineCalls.length).toBe(0);
  });

  it("refuses to re-obfuscate a .backup.<hash> copy named directly", async () => {
    writeFileSync(join(root, "app.backup.deadbeef.js"), "var original = 1;");
    expect(await invoke(["app.backup.deadbeef.js", "--protectionMap.enabled=false"])).toBe(1);
    expect(readFileSync(join(root, "app.backup.deadbeef.js"), "utf8")).toBe("var original = 1;");
  });

  it("keeps a file target out of its siblings' way inside a nested build dir", async () => {
    const nested = join(buildDir, "chunks");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "one.js"), "var one = 1;");
    writeFileSync(join(nested, "two.js"), "var two = 2;");

    expect(await invoke([join("dist", "chunks", "one.js"), "--protectionMap.enabled=false"])).toBe(
      0,
    );
    expect(readFileSync(join(nested, "one.js"), "utf8")).toContain("OBF:var one = 1;");
    expect(readFileSync(join(nested, "two.js"), "utf8")).toBe("var two = 2;");
  });
});

describe("run — node_modules", () => {
  beforeEach(() => {
    mkdirSync(join(buildDir, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(buildDir, "app.js"), "var a = 1;");
    writeFileSync(join(buildDir, "node_modules", "left-pad", "index.js"), "var dep = 2;");
  });

  it("skips nested node_modules by default", async () => {
    expect(await invoke(["dist", "--protectionMap.enabled=false"])).toBe(0);
    expect(engineCalls.map((c) => c.input)).toEqual(["var a = 1;"]);
    expect(readFileSync(join(buildDir, "node_modules", "left-pad", "index.js"), "utf8")).toBe(
      "var dep = 2;",
    );
  });

  it("obfuscates it when --paths.include opts back in", async () => {
    expect(
      await invoke(["dist", "--paths.include=**/node_modules/**", "--protectionMap.enabled=false"]),
    ).toBe(0);
    expect(engineCalls.map((c) => c.input).sort()).toEqual(["var a = 1;", "var dep = 2;"]);
    expect(readFileSync(join(buildDir, "node_modules", "left-pad", "index.js"), "utf8")).toContain(
      "OBF:var dep = 2;",
    );
  });

  it("reads the nearest afterpack.json and names it, relative to cwd — never an absolute path", async () => {
    writeFileSync(join(buildDir, "app.js"), "export const a = 1;");
    writeFileSync(join(root, "afterpack.json"), JSON.stringify({ preset: "medium" }));
    expect(await invoke(["dist", "--protectionMap.enabled=false"])).toBe(0);
    expect(out.join("\n")).toContain("using afterpack.json");
    expect(out.join("\n")).not.toContain(root);
    expect(engineCalls[0].config.preset).toBe("medium");
  });

  it("fails the run and names every rejected key rather than ignoring it", async () => {
    writeFileSync(join(buildDir, "app.js"), "export const a = 1;");
    expect(await invoke(["dist", "--level=medium", "--no-backup"])).toBe(64);
    const text = err.join("\n");
    expect(text).toContain("unknown configuration key `level`");
    expect(text).toContain("kebab-case");
    expect(engineCalls).toHaveLength(0);
  });

  it("documents the bundled-build reasoning in --help --all", async () => {
    out = [];
    await invoke(["--help", "--all"]);
    const help = out.join("\n");
    expect(help).toContain("--paths.include=<string[,...]>");
    expect(help).toContain("silent no-op");
  });
});
