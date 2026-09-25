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

describe("AfterPack never edits the user's own .gitignore", () => {
  it("leaves the project's .gitignore byte-for-byte untouched by a normal build", async () => {
    const project = repo("project", "node_modules/\n");
    buildOutput(project);

    expect(await invoke(project, ["dist", "--protectionMap.enabled=false"])).toBe(0);
    expect(readFileSync(join(project, ".gitignore"), "utf8")).toBe("node_modules/\n");

    writeFileSync(join(project, "dist", "app.js"), "export const a = 2;");
    expect(await invoke(project, ["dist", "--protectionMap.enabled=false"])).toBe(0);
    expect(readFileSync(join(project, ".gitignore"), "utf8")).toBe("node_modules/\n");
  });

  it("never writes a .gitignore anywhere under the build output", async () => {
    const project = repo("project", "node_modules/\n");
    const out = buildOutput(project);

    expect(await invoke(project, ["dist", "--protectionMap.enabled=false"])).toBe(0);

    expect(existsSync(join(out, ".gitignore"))).toBe(false);
  });

  it("leaves the working directory's own .gitignore alone when the target lives elsewhere", async () => {
    const here = repo("here", "node_modules/\n");
    const elsewhere = join(root, "elsewhere");
    const target = buildOutput(elsewhere);

    expect(await invoke(here, [target, "--protectionMap.enabled=false"])).toBe(0);

    expect(readFileSync(join(here, ".gitignore"), "utf8")).toBe("node_modules/\n");
    expect(existsSync(join(elsewhere, ".gitignore"))).toBe(false);
    expect(existsSync(join(target, ".gitignore"))).toBe(false);
  });
});

describe(".afterpack/ self-ignores instead of the project's .gitignore", () => {
  it("writes .afterpack/.gitignore with the self-ignoring `*` pattern once a run writes into .afterpack/", async () => {
    const project = repo("project", "node_modules/\n");
    buildOutput(project);

    expect(await invoke(project, ["dist", "--protectionMap.enabled=false"])).toBe(0);

    expect(readFileSync(join(project, ".afterpack", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("never overwrites an existing .afterpack/.gitignore", async () => {
    const project = repo("project", "node_modules/\n");
    buildOutput(project);
    mkdirSync(join(project, ".afterpack"), { recursive: true });
    writeFileSync(join(project, ".afterpack", ".gitignore"), "custom\n");

    expect(await invoke(project, ["dist", "--protectionMap.enabled=false"])).toBe(0);

    expect(readFileSync(join(project, ".afterpack", ".gitignore"), "utf8")).toBe("custom\n");
  });
});
