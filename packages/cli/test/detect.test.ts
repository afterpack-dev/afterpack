import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __reset, __setProcessResult, engineCalls, processBatch } from "../../../test/core-fake.js";
import { detectBuildOutput } from "../src/detect.js";
import { run } from "../src/run.js";

let root: string;
let out: string[];
let err: string[];

const logger = {
  log: (m: string) => out.push(m),
  error: (m: string) => err.push(m),
  warn: () => {},
};

function invoke(argv: string[], stdout?: { isTTY: boolean }): Promise<number> {
  return run({
    argv,
    cwd: root,
    engine: { processBatch },
    logger,
    version: "9.9.9",
    env: {},
    stdout: { isTTY: stdout?.isTTY ?? false, write: () => {} },
  });
}

function outputDir(name: string, ageSeconds: number): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "app.js"), `export const from = ${JSON.stringify(name)};`);
  const when = new Date(Date.now() - ageSeconds * 1000);
  utimesSync(dir, when, when);
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "afterpack-detect-"));
  out = [];
  err = [];
  __reset();
  __setProcessResult((input) => ({ code: `OBF:${input}`, sourceMap: null, protectionMap: null }));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("a bare `afterpack` picks the build output itself", () => {
  it("takes the NEWEST conventional directory and says which one it took", async () => {
    outputDir("dist", 600);
    outputDir("build", 5);

    expect(await invoke(["--protectionMap.enabled=false", "--telemetry.enabled=false"])).toBe(0);
    expect(out.join("\n")).toContain("no path given — using build/");
    expect(out.join("\n")).toContain("the newest build output here");
    expect(engineCalls.map((c) => c.input)).toEqual(['export const from = "build";']);
  });

  it("prefers the directory the detected bundler writes over a newer stale one", async () => {
    outputDir(".next", 600);
    outputDir("dist", 1);
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { next: "16" } }));

    expect(await invoke(["--protectionMap.enabled=false", "--telemetry.enabled=false"])).toBe(0);
    expect(out.join("\n")).toContain("using .next/ (Next.js writes it)");
    expect(engineCalls.map((c) => c.input)).toEqual(['export const from = ".next";']);
  });

  it("maps Nuxt onto .output/ and every other bundler onto dist/", async () => {
    outputDir(".output", 600);
    outputDir("dist", 1);
    writeFileSync(join(root, "package.json"), JSON.stringify({ devDependencies: { nuxt: "3" } }));
    expect(detectBuildOutput(root)).toEqual({ dir: ".output", reason: "Nuxt writes it" });

    writeFileSync(join(root, "package.json"), JSON.stringify({ devDependencies: { vite: "8" } }));
    expect(detectBuildOutput(root)).toEqual({ dir: "dist", reason: "Vite writes it" });
  });

  it("prints the quickstart and exits 1 when there is nothing to obfuscate", async () => {
    expect(await invoke([])).toBe(1);
    expect(err.join("\n")).toContain("build your project first");
    expect(err.join("\n")).toContain("npx afterpack@latest");
    expect(engineCalls).toHaveLength(0);
  });

  it("never prompts — a TTY behaves exactly like CI", async () => {
    outputDir("out", 5);
    const detectionLine = (): string | undefined => out.find((l) => l.includes("no path given"));
    const tty = await invoke(["--protectionMap.enabled=false", "--telemetry.enabled=false"], {
      isTTY: true,
    });
    const ttyLine = detectionLine();

    __reset();
    __setProcessResult((input) => ({ code: `OBF:${input}`, sourceMap: null, protectionMap: null }));
    out = [];
    outputDir("out", 5);
    const ci = await invoke(["--protectionMap.enabled=false", "--telemetry.enabled=false"], {
      isTTY: false,
    });

    expect([tty, ci]).toEqual([0, 0]);
    expect(detectionLine()).toBe(ttyLine);
    expect(ttyLine).toContain("using out/");
  });

  it("warns that the run is in place, because a second run has nothing to re-obfuscate from", async () => {
    outputDir("dist", 5);
    await invoke(["--protectionMap.enabled=false", "--telemetry.enabled=false"]);
    expect(out.join("\n")).toContain("IN PLACE");
  });

  it("ignores a conventional NAME that is a file rather than a directory", async () => {
    writeFileSync(join(root, "dist"), "not a directory");
    expect(detectBuildOutput(root)).toBeNull();
  });
});
