import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AfterpackFilesError, afterpackHome, describeUnanchoredHome } from "./home.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "afterpack-home-test-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function project(...markers: string[]): string {
  const dir = join(root, "project");
  mkdirSync(dir, { recursive: true });
  for (const marker of markers) writeFileSync(join(dir, marker), "");
  return dir;
}

function dirIn(base: string, ...segments: string[]): string {
  const dir = join(base, ...segments);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("afterpackHome", () => {
  it.each([
    "afterpack.json",
    ".git",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
  ])("sits next to the nearest %s above the build dir", (marker) => {
    const dir = project(marker);
    const home = afterpackHome(dirIn(dir, "dist", "app", "browser"));
    expect(home.dir).toBe(join(dir, ".afterpack"));
    expect(home.projectRoot).toBe(dir);
    expect(home.marker).toBe(marker);
    expect(home.strong).toBe(true);
    expect(describeUnanchoredHome(home)).toBeNull();
  });

  it("takes a .git file, as in a git worktree, as a marker", () => {
    const dir = project();
    writeFileSync(join(dir, ".git"), "gitdir: elsewhere");
    expect(afterpackHome(dirIn(dir, "dist")).dir).toBe(join(dir, ".afterpack"));
  });

  it("passes over a package.json a build emitted: Nitro's .output/server", () => {
    const dir = project("package-lock.json", "package.json");
    const server = dirIn(dir, ".output", "server");
    writeFileSync(join(server, "package.json"), "{}");
    expect(afterpackHome(dirIn(server, "chunks")).dir).toBe(join(dir, ".afterpack"));
    expect(afterpackHome(server, { fileTarget: true }).dir).toBe(join(dir, ".afterpack"));
  });

  it("passes over a dual-package dist/cjs/package.json", () => {
    const dir = project("pnpm-lock.yaml", "package.json");
    const cjs = dirIn(dir, "dist", "cjs");
    writeFileSync(join(cjs, "package.json"), '{"type":"commonjs"}');
    expect(afterpackHome(dirIn(cjs, "lib")).dir).toBe(join(dir, ".afterpack"));
  });

  it("keeps electron-builder's app/package.json layout at the lockfile root", () => {
    const dir = project("package-lock.json", "package.json");
    const app = dirIn(dir, "app");
    writeFileSync(join(app, "package.json"), "{}");
    expect(afterpackHome(dirIn(app, "dist")).dir).toBe(join(dir, ".afterpack"));
  });

  it("keeps every workspace package of a lockfile root in that root", () => {
    const dir = project("pnpm-lock.yaml", "package.json");
    for (const name of ["a", "b"]) {
      writeFileSync(join(dirIn(dir, "packages", name), "package.json"), "{}");
    }
    expect(afterpackHome(dirIn(dir, "packages", "a", "dist")).dir).toBe(join(dir, ".afterpack"));
    expect(afterpackHome(dirIn(dir, "packages", "b", "dist")).dir).toBe(join(dir, ".afterpack"));
  });

  it("falls back to the nearest package.json when no strong marker is above", () => {
    const dir = project("package.json");
    const home = afterpackHome(dirIn(dir, "dist"));
    expect(home.dir).toBe(join(dir, ".afterpack"));
    expect(home.marker).toBe("package.json");
    expect(home.strong).toBe(false);
  });

  it("never starts at the build dir itself, even when it holds a lockfile", () => {
    const dir = project("package-lock.json");
    const out = dirIn(dir, "out");
    writeFileSync(join(out, "package-lock.json"), "{}");
    expect(afterpackHome(out).dir).toBe(join(dir, ".afterpack"));
  });

  it("uses a file target's own dir when it holds a strong marker", () => {
    const dir = project("package-lock.json", "package.json");
    const home = afterpackHome(dir, { fileTarget: true });
    expect(home.dir).toBe(join(dir, ".afterpack"));
    expect(home.strong).toBe(true);
    expect(afterpackHome(dir).dir).toBe(join(root, ".afterpack"));
  });

  it("does not count a file target's own package.json alone", () => {
    const dir = project("package.json");
    expect(afterpackHome(dir, { fileTarget: true }).dir).toBe(join(root, ".afterpack"));
  });

  it("walks up from a file target's parent when its dir holds no strong marker", () => {
    const dir = project("package-lock.json");
    expect(afterpackHome(dirIn(dir, "public"), { fileTarget: true }).dir).toBe(
      join(dir, ".afterpack"),
    );
  });

  it("is the same for a build dir outside the bundler's own root", () => {
    const dir = project("package-lock.json");
    dirIn(dir, "client");
    dirIn(dir, "dist");
    expect(afterpackHome(join(dir, "client", "..", "dist")).dir).toBe(join(dir, ".afterpack"));
  });

  it("goes beside the build dir when no marker is above it, and says so", () => {
    const served = dirIn(root, "public");
    const home = afterpackHome(served);
    expect(home.dir).toBe(join(root, ".afterpack"));
    expect(home.marker).toBeNull();
    expect(describeUnanchoredHome(home)).toContain(
      `no lockfile, afterpack.json, .git or package.json above ${served}`,
    );
  });

  it("resolves a symlinked build dir to where it really is", () => {
    const dir = project("package-lock.json");
    symlinkSync(dirIn(dir, "dist"), join(root, "link"));
    expect(afterpackHome(join(root, "link")).dir).toBe(join(dir, ".afterpack"));
  });

  it("refuses a home that would sit inside the build dir, with its own error", () => {
    expect(() => afterpackHome("/")).toThrow(AfterpackFilesError);
    expect(() => afterpackHome("/")).toThrow(/inside the build output/);
  });
});
