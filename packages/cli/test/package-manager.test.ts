import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectPackageManager } from "../src/package-manager.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "afterpack-pm-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("detectPackageManager", () => {
  it("reads pnpm-lock.yaml as pnpm", () => {
    writeFileSync(join(root, "pnpm-lock.yaml"), "");
    const pm = detectPackageManager(root);
    expect(pm.name).toBe("pnpm");
    expect(pm.install("@afterpack/vite")).toBe("pnpm add -D @afterpack/vite");
    expect(pm.run("build")).toBe("pnpm build");
  });

  it("reads yarn.lock as yarn", () => {
    writeFileSync(join(root, "yarn.lock"), "");
    const pm = detectPackageManager(root);
    expect(pm.name).toBe("yarn");
    expect(pm.install("@afterpack/vite")).toBe("yarn add -D @afterpack/vite");
  });

  it("reads bun.lockb as bun, with the lowercase -d flag", () => {
    writeFileSync(join(root, "bun.lockb"), "");
    const pm = detectPackageManager(root);
    expect(pm.name).toBe("bun");
    expect(pm.install("@afterpack/vite")).toBe("bun add -d @afterpack/vite");
  });

  it("reads bun.lock (the text lockfile) as bun too", () => {
    writeFileSync(join(root, "bun.lock"), "");
    expect(detectPackageManager(root).name).toBe("bun");
  });

  it("reads package-lock.json as npm", () => {
    writeFileSync(join(root, "package-lock.json"), "");
    const pm = detectPackageManager(root);
    expect(pm.name).toBe("npm");
    expect(pm.install("@afterpack/vite")).toBe("npm install -D @afterpack/vite");
  });

  it("defaults to npm when no lockfile is found anywhere above cwd", () => {
    expect(detectPackageManager(root).name).toBe("npm");
  });

  it("finds the lockfile in the nearest directory AT OR ABOVE cwd, not only in cwd itself", () => {
    writeFileSync(join(root, "pnpm-lock.yaml"), "");
    const nested = join(root, "packages", "app");
    mkdirSync(nested, { recursive: true });
    expect(detectPackageManager(nested).name).toBe("pnpm");
  });

  it("prefers the nearer lockfile over a farther, different one", () => {
    writeFileSync(join(root, "pnpm-lock.yaml"), "");
    const nested = join(root, "packages", "app");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "yarn.lock"), "");
    expect(detectPackageManager(nested).name).toBe("yarn");
  });
});
