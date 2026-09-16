import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __reset, __setProcessResult, engineCalls, processBatch } from "../../../test/core-fake.js";
import {
  detectBuildOutput,
  detectFramework,
  detectIntegration,
  FRAMEWORKS,
} from "../src/detect.js";
import { stripAnsi } from "../src/format.js";
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
    expect(out.join("\n")).toContain("Using build/");
    expect(out.join("\n")).toContain("the newest build output here");
    expect(engineCalls.map((c) => c.input)).toEqual(['export const from = "build";']);
  });

  it("prefers the directory the detected bundler writes over a newer stale one", () => {
    outputDir(".next", 600);
    outputDir("dist", 1);
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { next: "16" } }));

    expect(detectBuildOutput(root)).toEqual({ dir: ".next", reason: "Next.js writes it" });
  });

  it("maps Nuxt onto .output/ and every other bundler onto dist/", async () => {
    outputDir(".output", 600);
    outputDir("dist", 1);
    writeFileSync(join(root, "package.json"), JSON.stringify({ devDependencies: { nuxt: "3" } }));
    expect(detectBuildOutput(root)).toEqual({ dir: ".output", reason: "Nuxt writes it" });

    writeFileSync(join(root, "package.json"), JSON.stringify({ devDependencies: { vite: "8" } }));
    expect(detectBuildOutput(root)).toEqual({ dir: "dist", reason: "Vite writes it" });
  });

  it("refuses cleanly and exits 1 when there is nothing to obfuscate", async () => {
    expect(await invoke([])).toBe(1);
    expect(err.join("\n")).toContain("No framework detected in this directory.");
    expect(err.join("\n")).toContain("afterpack dist/");
    expect(err.join("\n")).toContain("afterpack app.js");
    expect(engineCalls).toHaveLength(0);
  });

  it("never prompts — a TTY behaves exactly like CI", async () => {
    outputDir("out", 5);
    const detectionLine = (): string | undefined => out.find((l) => l.includes("Using "));
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

    const plain = (line: string | undefined): string | undefined =>
      line === undefined ? undefined : stripAnsi(line);

    expect([tty, ci]).toEqual([0, 0]);
    expect(plain(detectionLine())).toBe(plain(ttyLine));
    expect(plain(ttyLine)).toContain("Using out/");
  });

  it("warns that the run is in place, because a second run has nothing to re-obfuscate from", async () => {
    outputDir("dist", 5);
    await invoke(["--protectionMap.enabled=false", "--telemetry.enabled=false"]);
    expect(out.join("\n")).toContain("protected in place");
  });

  it("ignores a conventional NAME that is a file rather than a directory", async () => {
    writeFileSync(join(root, "dist"), "not a directory");
    expect(detectBuildOutput(root)).toBeNull();
  });
});

function pkg(deps: Record<string, string>): void {
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: deps }));
}

describe("detectFramework knows all 13 frameworks and picks the most specific one", () => {
  it("resolves every framework in FRAMEWORKS from its own dependency, alone", () => {
    for (const framework of FRAMEWORKS) {
      pkg({ [framework.dep]: "1.0.0" });
      expect(detectFramework(root)).toEqual(framework);
    }
  });

  it("resolves SvelteKit over Svelte and Vite when all three are present", () => {
    pkg({ "@sveltejs/kit": "2.0.0", svelte: "5.0.0", vite: "6.0.0" });
    expect(detectFramework(root)?.name).toBe("SvelteKit");
  });

  it("resolves Astro over Vite when both are present", () => {
    pkg({ astro: "4.0.0", vite: "6.0.0" });
    expect(detectFramework(root)?.name).toBe("Astro");
  });

  it("resolves Nuxt over Vite when both are present", () => {
    pkg({ nuxt: "3.0.0", vite: "6.0.0" });
    expect(detectFramework(root)?.name).toBe("Nuxt");
  });

  it("returns null when package.json names no known framework", () => {
    pkg({ lodash: "4.0.0" });
    expect(detectFramework(root)).toBeNull();
  });
});

describe("detectIntegration", () => {
  it("is true only when that framework's own @afterpack/* package is a dependency", () => {
    const vite = FRAMEWORKS.find((f) => f.name === "Vite");
    if (!vite) throw new Error("Vite missing from FRAMEWORKS");
    pkg({ vite: "6.0.0" });
    expect(detectIntegration(root, vite)).toBe(false);

    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        dependencies: { vite: "6.0.0" },
        devDependencies: { "@afterpack/vite": "0.1.0" },
      }),
    );
    expect(detectIntegration(root, vite)).toBe(true);
  });
});
