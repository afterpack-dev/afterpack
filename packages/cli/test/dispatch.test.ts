import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __reset, __setProcessResult, engineCalls, processBatch } from "../../../test/core-fake.js";
import { stripAnsi } from "../src/format.js";
import { run } from "../src/run.js";

let root: string;
let out: string[];
let err: string[];
let warned: string[];

const logger = {
  log: (m: string) => out.push(m),
  error: (m: string) => err.push(m),
  warn: (m: string) => warned.push(m),
};

function invoke(argv: string[]): Promise<number> {
  return run({
    argv,
    cwd: root,
    engine: { processBatch },
    logger,
    version: "9.9.9",
    env: {},
    stdout: { isTTY: false, write: () => {} },
  });
}

function pkg(deps: Record<string, string>, devDeps: Record<string, string> = {}): void {
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ dependencies: deps, devDependencies: devDeps }),
  );
}

function buildOutput(name = "dist"): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "app.js"), "export const a = 1;");
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "afterpack-dispatch-"));
  out = [];
  err = [];
  warned = [];
  __reset();
  __setProcessResult((input) => ({ code: `OBF:${input}`, sourceMap: null, protectionMap: null }));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("bare `afterpack` dispatch — 1: an @afterpack/* integration is installed", () => {
  it("refuses, names the installed package and the build command, never obfuscates", async () => {
    pkg({ vite: "6.0.0" }, { "@afterpack/vite": "0.1.0" });

    expect(await invoke([])).toBe(1);
    const text = err.join("\n");
    expect(text).toContain("@afterpack/vite is installed.");
    expect(text).toContain("$ npm run build");
    expect(text).toContain("docs https://www.afterpack.dev/docs/frameworks/vite");
    expect(text).not.toContain("or protect this build once");
    expect(engineCalls).toHaveLength(0);
  });

  it("takes precedence even when a build output directory also exists", async () => {
    pkg({ next: "16.0.0" }, { "@afterpack/next": "0.1.0" });
    buildOutput(".next");

    expect(await invoke([])).toBe(1);
    expect(err.join("\n")).toContain("@afterpack/next is installed.");
    expect(engineCalls).toHaveLength(0);
  });
});

describe("bare `afterpack` dispatch — 2: a framework is detected, no integration installed", () => {
  it("refuses and names the install command and docs, with no build output", async () => {
    pkg({ vite: "6.0.0" });

    expect(await invoke([])).toBe(1);
    const text = err.join("\n");
    expect(text).toContain("Vite detected.");
    expect(text).toContain("$ npm install -D @afterpack/vite");
    expect(text).toContain("docs https://www.afterpack.dev/docs/frameworks/vite");
    expect(text).not.toContain("or protect this build once");
    expect(engineCalls).toHaveLength(0);
  });

  it("guides to the integration only, never to a one-off run over the framework's build dir", async () => {
    pkg({ next: "16.0.0" });
    buildOutput(".next");

    expect(await invoke([])).toBe(1);
    const text = err.join("\n");
    expect(text).toContain("Next.js detected.");
    expect(text).toContain("$ npm install -D @afterpack/next");
    expect(text).not.toContain("afterpack .next/");
    expect(text).not.toContain("protect this build once");
    expect(engineCalls).toHaveLength(0);
  });

  it("uses the detected package manager's install syntax", async () => {
    pkg({ vue: "3.0.0" });
    writeFileSync(join(root, "yarn.lock"), "");

    expect(await invoke([])).toBe(1);
    expect(err.join("\n")).toContain("$ yarn add -D @afterpack/vue");
  });
});

describe("bare `afterpack` dispatch — 3: no framework, but a build output exists", () => {
  it("obfuscates it exactly as before", async () => {
    buildOutput("dist");

    expect(await invoke(["--protectionMap.enabled=false", "--telemetry.enabled=false"])).toBe(0);
    expect(engineCalls).toHaveLength(1);
  });
});

describe("bare `afterpack` dispatch — 4: nothing detected, nothing built", () => {
  it("refuses with the quickstart hint", async () => {
    expect(await invoke([])).toBe(1);
    const text = err.join("\n");
    expect(text).toContain("No framework detected in this directory.");
    expect(text).toContain("afterpack dist/");
    expect(text).toContain("protect a built directory");
    expect(text).toContain("afterpack app.js");
    expect(text).toContain("protect one file");
    expect(text).toContain("docs https://www.afterpack.dev/docs/cli");
    expect(engineCalls).toHaveLength(0);
  });
});

describe("an explicit path pointed at a BUILD directory (no package.json) still obfuscates", () => {
  it("obfuscates even in a project with an integration already installed", async () => {
    pkg({ vite: "6.0.0" }, { "@afterpack/vite": "0.1.0" });
    buildOutput("dist");

    const code = await invoke([
      "dist",
      "--protectionMap.enabled=false",
      "--telemetry.enabled=false",
    ]);
    expect(code).toBe(0);
    expect(engineCalls).toHaveLength(1);
  });

  it("obfuscates even when a framework is detected with no integration installed", async () => {
    pkg({ next: "16.0.0" });
    buildOutput("dist");

    const code = await invoke([
      "dist",
      "--protectionMap.enabled=false",
      "--telemetry.enabled=false",
    ]);
    expect(code).toBe(0);
    expect(engineCalls).toHaveLength(1);
  });
});

describe("an explicit path pointed at a PROJECT (its own package.json) dispatches instead — the data-destroying bug", () => {
  function nextProject(name: string): string {
    const dir = join(root, name);
    mkdirSync(join(dir, "app"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { next: "16.0.0" } }));
    writeFileSync(join(dir, "app", "page.js"), "export default function Page() {}\n");
    writeFileSync(join(dir, "postcss.config.mjs"), "export default {};\n");
    writeFileSync(join(dir, "eslint.config.mjs"), "export default [];\n");
    return dir;
  }

  it("`afterpack <project>` dispatches (framework guidance, exit 1) and touches NO source file", async () => {
    const dir = nextProject("test-next");
    const before = {
      page: readFileSync(join(dir, "app", "page.js"), "utf8"),
      postcss: readFileSync(join(dir, "postcss.config.mjs"), "utf8"),
      eslint: readFileSync(join(dir, "eslint.config.mjs"), "utf8"),
    };

    const code = await invoke(["test-next"]);

    expect(code).toBe(1);
    const text = err.join("\n");
    expect(text).toContain("Next.js detected.");
    expect(text).toContain("$ npm install -D @afterpack/next");
    expect(engineCalls).toHaveLength(0);
    expect(readFileSync(join(dir, "app", "page.js"), "utf8")).toBe(before.page);
    expect(readFileSync(join(dir, "postcss.config.mjs"), "utf8")).toBe(before.postcss);
    expect(readFileSync(join(dir, "eslint.config.mjs"), "utf8")).toBe(before.eslint);
  });

  it("`afterpack .` inside a project root behaves identically to the bare command", async () => {
    pkg({ vite: "6.0.0" });

    const bare = await invoke([]);
    const barePlain = stripAnsi(err.join("\n"));

    __reset();
    __setProcessResult((input) => ({ code: `OBF:${input}`, sourceMap: null, protectionMap: null }));
    err = [];
    const dot = await invoke(["."]);
    const dotPlain = stripAnsi(err.join("\n"));

    expect([bare, dot]).toEqual([1, 1]);
    expect(dotPlain).toBe(barePlain);
    expect(engineCalls).toHaveLength(0);
  });

  it("an integration already installed still dispatches for an explicit project path", async () => {
    const dir = join(root, "test-next");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        dependencies: { next: "16.0.0" },
        devDependencies: { "@afterpack/next": "0.1.0" },
      }),
    );
    writeFileSync(join(dir, "app.js"), "export const a = 1;");

    expect(await invoke(["test-next"])).toBe(1);
    expect(err.join("\n")).toContain("@afterpack/next is installed.");
    expect(engineCalls).toHaveLength(0);
    expect(readFileSync(join(dir, "app.js"), "utf8")).toBe("export const a = 1;");
  });

  it("a project with no framework and no build output refuses with the quickstart hint", async () => {
    const dir = join(root, "plain-project");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { lodash: "4.0.0" } }));
    writeFileSync(join(dir, "index.js"), "module.exports = 1;");

    expect(await invoke(["plain-project"])).toBe(1);
    expect(err.join("\n")).toContain("No framework detected in this directory.");
    expect(engineCalls).toHaveLength(0);
  });

  it("a nested project inside a protected directory is skipped by the walk", async () => {
    const dist = buildOutput("dist");
    const nested = join(dist, "vendor-widget");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "package.json"), "{}");
    writeFileSync(join(nested, "index.js"), "export const nested = 1;");

    const code = await invoke([
      "dist",
      "--protectionMap.enabled=false",
      "--telemetry.enabled=false",
    ]);
    expect(code).toBe(0);
    expect(engineCalls.map((c) => c.input)).toEqual(["export const a = 1;"]);
    expect(readFileSync(join(nested, "index.js"), "utf8")).toBe("export const nested = 1;");
  });

  it("says out loud which nested projects it skipped, so a skip is never silent", async () => {
    const dist = buildOutput("dist");
    const nested = join(dist, "standalone");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "package.json"), "{}");
    writeFileSync(join(nested, "server.js"), "export const nested = 1;");

    expect(
      await invoke(["dist", "--protectionMap.enabled=false", "--telemetry.enabled=false"]),
    ).toBe(0);
    const text = stripAnsi(warned.join("\n"));
    expect(text).toContain("Skipped dist/standalone/");
    expect(text).toContain("nested project");
  });

  it("a FILE argument is unaffected even from inside a project root", async () => {
    pkg({ vite: "6.0.0" });
    const file = join(root, "app.js");
    writeFileSync(file, "var a = 1;");

    expect(
      await invoke(["app.js", "--protectionMap.enabled=false", "--telemetry.enabled=false"]),
    ).toBe(0);
    expect(engineCalls).toHaveLength(1);
  });
});
