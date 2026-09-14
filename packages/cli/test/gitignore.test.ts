import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __reset, __setProcessResult, processBatch } from "../../../test/core-fake.js";
import { run } from "../src/run.js";

let root: string;

const logger = { log: () => {}, error: () => {}, warn: () => {} };

function invoke(cwd: string, argv: string[]): Promise<number> {
  return run({ argv, cwd, engine: { processBatch }, logger, version: "9.9.9", env: {} });
}

function repo(name: string, gitignore: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), gitignore);
  return dir;
}

function buildOutput(dir: string): string {
  const out = join(dir, "dist");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "app.js"), "export const a = 1;");
  return out;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "afterpack-cli-gitignore-"));
  __reset();
  __setProcessResult((input) => ({ code: `OBF:${input}`, sourceMap: null, protectionMap: null }));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the .gitignore auto-add is anchored on the target, never on the working directory", () => {
  it("leaves the working directory's repository alone when the target lives outside it", async () => {
    const here = repo("here", "node_modules/\n");
    const elsewhere = join(root, "elsewhere");
    const target = buildOutput(elsewhere);

    expect(await invoke(here, [target, "--protectionMap.enabled=false"])).toBe(0);

    expect(readFileSync(join(here, ".gitignore"), "utf8")).toBe("node_modules/\n");
    expect(existsSync(join(elsewhere, ".gitignore"))).toBe(false);
    expect(existsSync(join(target, ".gitignore"))).toBe(false);
  });

  it("adds the block once to the .gitignore above the target, then leaves it alone", async () => {
    const project = repo("project", "node_modules/\n");
    buildOutput(project);

    expect(await invoke(project, ["dist", "--protectionMap.enabled=false"])).toBe(0);
    const afterFirst = readFileSync(join(project, ".gitignore"), "utf8");
    expect(afterFirst).toContain("node_modules/");
    expect(afterFirst).toContain(".afterpack/");
    expect(afterFirst).toContain("*.backup.*");

    writeFileSync(join(project, "dist", "app.js"), "export const a = 2;");
    expect(await invoke(project, ["dist", "--protectionMap.enabled=false"])).toBe(0);
    expect(readFileSync(join(project, ".gitignore"), "utf8")).toBe(afterFirst);
  });
});
