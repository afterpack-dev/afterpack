import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProtectionReceipt } from "@afterpack/integration-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __reset, __setProcessResult, processBatch } from "../../../test/core-fake.js";
import { run } from "../src/run.js";

const BUILD_ID = "build-abc";

let root: string;
let out: string[];
let err: string[];

const logger = {
  log: (m: string) => out.push(m),
  error: (m: string) => err.push(m),
  warn: () => {},
};

function invokeIn(cwd: string, argv: string[]): Promise<number> {
  return run({ argv, cwd, engine: { processBatch }, logger, version: "9.9.9", env: {} });
}

function invoke(argv: string[]): Promise<number> {
  return invokeIn(root, argv);
}

function protectedBuild(opts: { transformed?: boolean } = {}): { distDir: string; chunk: string } {
  const distDir = join(root, ".next");
  const chunks = join(distDir, "static", "chunks");
  mkdirSync(chunks, { recursive: true });
  const chunk = join(chunks, "main.js");
  writeFileSync(chunk, "OBF:export const a = 1;");
  writeFileSync(join(distDir, "BUILD_ID"), BUILD_ID);
  writeProtectionReceipt({
    dir: distDir,
    tool: "@afterpack/next",
    engine: "cloud",
    engineVersion: "9.9.9-test",
    seed: 4242,
    seedOrigin: "option",
    bundler: "turbopack",
    buildId: BUILD_ID,
    files: [chunk],
    transformed: opts.transformed === false ? [] : [chunk],
  });
  return { distDir, chunk };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "afterpack-verify-test-")));
  out = [];
  err = [];
  __reset();
  __setProcessResult((input) => ({ code: `OBF:${input}`, sourceMap: null, protectionMap: null }));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("afterpack verify", () => {
  it("passes on a freshly protected build, found through the project root", async () => {
    protectedBuild();
    expect(await invoke(["verify", "."])).toBe(0);
    expect(out.join("\n")).toContain("Verified 1 file");
  });

  it("FAILS a receipt that lists files the engine never changed", async () => {
    const { distDir } = protectedBuild({ transformed: false });
    expect(await invoke(["verify", distDir])).toBe(1);
    expect(err.join("\n")).toContain("the engine changed NONE of them");
  });

  it("defaults to the working directory when no dir is given", async () => {
    protectedBuild();
    expect(await invoke(["verify"])).toBe(0);
  });

  it("accepts the build output directory itself", async () => {
    protectedBuild();
    expect(await invoke(["verify", ".next"])).toBe(0);
  });

  it("FAILS when a chunk was replaced after the build", async () => {
    const { chunk } = protectedBuild();
    writeFileSync(chunk, "export const a = 1;");

    expect(await invoke(["verify", "."])).toBe(1);
    expect(err.join("\n")).toContain("content changed since it was obfuscated");
  });

  it("FAILS when a recorded file is gone", async () => {
    const { chunk } = protectedBuild();
    rmSync(chunk);

    expect(await invoke(["verify", "."])).toBe(1);
    expect(err.join("\n")).toContain("missing now");
  });

  it("FAILS when the tree was rebuilt without the wrapper (receipt is for another build)", async () => {
    const { distDir } = protectedBuild();
    writeFileSync(join(distDir, "BUILD_ID"), "a-different-build");

    expect(await invoke(["verify", "."])).toBe(1);
    expect(err.join("\n")).toContain("rebuilt without the AfterPack wrapper");
  });

  it("FAILS, never passes silently, when there is no receipt at all", async () => {
    mkdirSync(join(root, ".next", "static", "chunks"), { recursive: true });
    writeFileSync(join(root, ".next", "static", "chunks", "main.js"), "export const a = 1;");

    expect(await invoke(["verify", "."])).toBe(1);
    expect(err.join("\n")).toContain("no protection receipt found");
  });

  it("reports a path that does not exist rather than a missing receipt", async () => {
    expect(await invoke(["verify", "nope"])).toBe(1);
    expect(err.join("\n")).toContain("path not found: nope");
  });

  it("rejects a second positional", async () => {
    expect(await invoke(["verify", ".", "also-this"])).toBe(64);
    expect(err.join("\n")).toContain("expected a single [dir]");
  });

  it("emits ONE json document naming the receipt, and a json ERROR document when it fails", async () => {
    protectedBuild();
    expect(await invoke(["verify", ".", "--diagnostics.format=json"])).toBe(0);
    expect(out).toHaveLength(1);
    const doc = JSON.parse(out[0]) as Record<string, unknown>;
    expect(doc).toMatchObject({ command: "verify", exitCode: 0, ok: true });
    expect(doc.summary).toMatchObject({
      tool: "@afterpack/next",
      buildId: BUILD_ID,
      files: 1,
      directory: ".next",
      receipt: ".afterpack/receipts/.next.json",
    });
    expect(doc.files).toEqual([
      {
        path: "static/chunks/main.js",
        status: "obfuscated",
        bytesIn: 0,
        bytesOut: 0,
        diagnostics: [],
      },
    ]);

    out = [];
    expect(await invoke(["verify", "nope", "--diagnostics.format=json"])).toBe(1);
    expect(JSON.parse(out[0])).toMatchObject({
      command: "verify",
      exitCode: 1,
      ok: false,
      error: { code: "PATH_NOT_FOUND" },
    });
  });

  it("rejects a flag it does not have rather than ignoring it", async () => {
    protectedBuild();
    expect(await invoke(["verify", ".", "--preset=hard"])).toBe(64);
    expect(err.join("\n")).toContain("not an option of `afterpack verify`");
  });

  it("runs with no configuration at all — an afterpack.json the CLI cannot honour never reaches it", async () => {
    protectedBuild();
    writeFileSync(join(root, "afterpack.json"), JSON.stringify({ directives: { enabled: true } }));

    expect(await invoke(["verify", "."])).toBe(0);
  });
});

describe("afterpack <dir> writes the receipt afterpack verify reads", () => {
  const QUIET = ["--protectionMap.enabled=false", "--telemetry.enabled=false"];

  function buildOutput(name = "dist"): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "app.js"), "export const a = 1;");
    return dir;
  }

  it("passes the deploy gate straight after a plain `afterpack dist` run", async () => {
    buildOutput();

    expect(await invoke(["dist", ...QUIET])).toBe(0);
    expect(await invoke(["verify", "dist"])).toBe(0);
    expect(out.join("\n")).toContain("Verified 1 file");
  });

  it("keeps the receipt in .afterpack/receipts/, out of the tree that ships", async () => {
    const dist = buildOutput();

    expect(await invoke(["dist", ...QUIET])).toBe(0);
    expect(existsSync(join(root, ".afterpack", "receipts", "dist.json"))).toBe(true);
    expect(readdirSync(dist)).toEqual(["app.js"]);
  });

  it("removes a stale receipt an earlier run left in the tree, and still verifies", async () => {
    const dist = buildOutput();
    writeFileSync(join(dist, ".afterpack-protection.json"), "{}");

    expect(await invoke(["dist", ...QUIET])).toBe(0);
    expect(readdirSync(dist)).toEqual(["app.js"]);
    expect(await invoke(["verify", "dist"])).toBe(0);
  });

  it("keeps one receipt per protected dir and verifies each against its own", async () => {
    buildOutput("web");
    buildOutput("worker");

    expect(await invoke(["web", ...QUIET])).toBe(0);
    expect(await invoke(["worker", ...QUIET])).toBe(0);
    expect(readdirSync(join(root, ".afterpack", "receipts")).sort()).toEqual([
      "web.json",
      "worker.json",
    ]);
    expect(await invoke(["verify", "web"])).toBe(0);
    expect(await invoke(["verify", "worker"])).toBe(0);
  });

  it("finds the receipt from a nested working directory", async () => {
    buildOutput();
    expect(await invoke(["dist", ...QUIET])).toBe(0);
    expect(await invokeIn(join(root, "dist"), ["verify", "."])).toBe(0);
  });

  it("refuses a re-run over the same tree from any working directory", async () => {
    const p2 = join(root, "p2");
    mkdirSync(join(p2, "dist"), { recursive: true });
    writeFileSync(join(p2, "dist", "app.js"), "export const a = 1;");

    expect(await invokeIn(p2, ["dist", ...QUIET, "--build.backup=false"])).toBe(0);
    const once = readFileSync(join(p2, "dist", "app.js"), "utf8");

    err = [];
    expect(await invokeIn(root, ["p2/dist", ...QUIET, "--build.backup=false"])).toBe(1);
    expect(err.join("\n")).toContain("Already obfuscated");
    err = [];
    expect(await invokeIn(join(p2, "dist"), [".", ...QUIET, "--build.backup=false"])).toBe(1);
    expect(err.join("\n")).toContain("Already obfuscated");

    expect(readFileSync(join(p2, "dist", "app.js"), "utf8")).toBe(once);
    expect(readdirSync(join(p2, ".afterpack", "receipts"))).toEqual(["dist.json"]);
  });

  it("refuses a re-run from another working directory through the backup manifest too", async () => {
    const p2 = join(root, "p2");
    mkdirSync(join(p2, "dist"), { recursive: true });
    writeFileSync(join(p2, "dist", "app.js"), "export const a = 1;");
    expect(await invokeIn(p2, ["dist", ...QUIET])).toBe(0);
    rmSync(join(p2, ".afterpack", "receipts"), { recursive: true });

    expect(await invokeIn(root, ["p2/dist", ...QUIET])).toBe(1);
    expect(err.join("\n")).toContain("Already obfuscated");
    expect(existsSync(join(p2, ".afterpack", "backup", "manifest.json"))).toBe(true);
  });

  it("keeps the receipt and the backup together next to the project marker, whatever the cwd", async () => {
    writeFileSync(join(root, "afterpack.json"), "{}");
    const project = join(root, "apps", "web");
    mkdirSync(join(project, "dist"), { recursive: true });
    writeFileSync(join(project, "package.json"), "{}");
    writeFileSync(join(project, "dist", "app.js"), "export const a = 1;");

    expect(await invoke(["apps/web/dist", ...QUIET])).toBe(0);

    expect(readdirSync(join(project, ".afterpack")).sort()).toEqual([
      ".gitignore",
      "backup",
      "receipts",
    ]);
    expect(existsSync(join(root, ".afterpack"))).toBe(false);
    expect(await invokeIn(join(project, "dist"), ["verify"])).toBe(0);
    expect(await invokeIn(project, ["restore"])).toBe(0);
    expect(readFileSync(join(project, "dist", "app.js"), "utf8")).toBe("export const a = 1;");
  });

  it("puts .afterpack beside a bare served folder, never inside it", async () => {
    const served = join(root, "public");
    mkdirSync(served);
    writeFileSync(join(served, "app.js"), "export const a = 1;");

    expect(await invokeIn(served, [".", ...QUIET])).toBe(0);

    expect(readdirSync(served)).toEqual(["app.js"]);
    expect(existsSync(join(root, ".afterpack", "receipts", "public.json"))).toBe(true);
    expect(existsSync(join(root, ".afterpack", "backup", "manifest.json"))).toBe(true);
    expect(out.join("\n")).toContain("no package.json, afterpack.json or .git above");
    expect(await invokeIn(served, ["verify"])).toBe(0);
    expect(await invokeIn(served, ["restore"])).toBe(0);
    expect(readFileSync(join(served, "app.js"), "utf8")).toBe("export const a = 1;");
  });

  it("fails, touching nothing, when a .afterpack/ dir sits inside the build output", async () => {
    const dist = buildOutput();
    mkdirSync(join(dist, ".afterpack", "backup"), { recursive: true });

    expect(await invoke(["dist", ...QUIET])).toBe(1);
    expect(err.join("\n")).toContain(`found ${join(dist, ".afterpack")} inside the build output`);
    expect(err.join("\n")).toContain("Delete it, then build again");
    expect(readFileSync(join(dist, "app.js"), "utf8")).toBe("export const a = 1;");
  });

  it("verifies a case-different spelling of the same dir on a case-insensitive disk", async () => {
    buildOutput();
    if (!existsSync(join(root, "DIST"))) return;
    expect(await invoke(["dist", ...QUIET])).toBe(0);
    expect(await invoke(["verify", "DIST"])).toBe(0);
    err = [];
    expect(await invoke(["Dist", ...QUIET])).toBe(1);
    expect(err.join("\n")).toContain("Already obfuscated");
  });

  it("FAILS the gate when a file is replaced after the run", async () => {
    const dist = buildOutput();

    expect(await invoke(["dist", ...QUIET])).toBe(0);
    writeFileSync(join(dist, "app.js"), "export const a = 1;");

    expect(await invoke(["verify", "dist"])).toBe(1);
    expect(err.join("\n")).toContain("content changed since it was obfuscated");
  });

  it("refuses a second run over the same unrebuilt tree, and accepts the rebuilt one", async () => {
    const dist = buildOutput();
    expect(await invoke(["dist", ...QUIET])).toBe(0);

    expect(await invoke(["dist", ...QUIET])).toBe(1);
    expect(err.join("\n")).toContain("Already obfuscated");

    out = [];
    err = [];
    writeFileSync(join(dist, "app.js"), "export const a = 2;");
    expect(await invoke(["dist", ...QUIET])).toBe(0);
    expect(await invoke(["verify", "dist"])).toBe(0);
  });

  it("records the tree's BUILD_ID, so verify does not read the run as a wrapper-less rebuild", async () => {
    const dist = buildOutput(".next");
    writeFileSync(join(dist, "BUILD_ID"), BUILD_ID);

    expect(await invoke([".next", ...QUIET])).toBe(0);
    out = [];
    expect(await invoke(["verify", ".", "--diagnostics.format=json"])).toBe(0);
    const doc = JSON.parse(out[0]) as { summary: { buildId: string } };
    expect(doc.summary.buildId).toBe(BUILD_ID);
  });
});
