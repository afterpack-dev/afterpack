import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { afterpackHome, describeUnanchoredHome } from "./home.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "afterpack-home-test-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("afterpackHome", () => {
  it.each([
    "package.json",
    "afterpack.json",
    ".git",
  ])("sits next to the nearest %s above the build dir", (marker) => {
    const project = join(root, "project");
    mkdirSync(join(project, "dist", "app", "browser"), { recursive: true });
    writeFileSync(join(project, marker), "");
    const home = afterpackHome(join(project, "dist", "app", "browser"));
    expect(home.dir).toBe(join(project, ".afterpack"));
    expect(home.projectRoot).toBe(project);
    expect(home.marker).toBe(marker);
    expect(describeUnanchoredHome(home)).toBeNull();
  });

  it("takes the nearest marker, so a workspace package keeps its own", () => {
    const pkg = join(root, "packages", "app");
    mkdirSync(join(pkg, "dist"), { recursive: true });
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(pkg, "package.json"), "{}");
    expect(afterpackHome(join(pkg, "dist")).dir).toBe(join(pkg, ".afterpack"));
  });

  it("never starts at the build dir itself, even when it holds a package.json", () => {
    const project = join(root, "project");
    mkdirSync(join(project, "out"), { recursive: true });
    writeFileSync(join(project, "package.json"), "{}");
    writeFileSync(join(project, "out", "package.json"), "{}");
    expect(afterpackHome(join(project, "out")).dir).toBe(join(project, ".afterpack"));
  });

  it("uses a file target's own dir when that dir is a project root", () => {
    const project = join(root, "project");
    mkdirSync(project);
    writeFileSync(join(project, "package.json"), "{}");
    const home = afterpackHome(project, { fileTarget: true });
    expect(home.dir).toBe(join(project, ".afterpack"));
    expect(home.projectRoot).toBe(project);
    expect(afterpackHome(project).dir).toBe(join(root, ".afterpack"));
  });

  it("walks up from a file target's parent when its dir is no project root", () => {
    const project = join(root, "project");
    mkdirSync(join(project, "public"), { recursive: true });
    writeFileSync(join(project, "package.json"), "{}");
    expect(afterpackHome(join(project, "public"), { fileTarget: true }).dir).toBe(
      join(project, ".afterpack"),
    );
  });

  it("is the same for a build dir outside the bundler's own root", () => {
    const project = join(root, "project");
    mkdirSync(join(project, "client"), { recursive: true });
    mkdirSync(join(project, "dist"), { recursive: true });
    writeFileSync(join(project, "package.json"), "{}");
    expect(afterpackHome(join(project, "client", "..", "dist")).dir).toBe(
      join(project, ".afterpack"),
    );
  });

  it("goes beside the build dir when no marker is above it, and says so", () => {
    const served = join(root, "public");
    mkdirSync(served);
    const home = afterpackHome(served);
    expect(home.dir).toBe(join(root, ".afterpack"));
    expect(home.marker).toBeNull();
    expect(describeUnanchoredHome(home)).toContain(
      `no package.json, afterpack.json or .git above ${served}`,
    );
  });

  it("resolves a symlinked build dir to where it really is", () => {
    const project = join(root, "project");
    mkdirSync(join(project, "dist"), { recursive: true });
    writeFileSync(join(project, "package.json"), "{}");
    symlinkSync(join(project, "dist"), join(root, "link"));
    expect(afterpackHome(join(root, "link")).dir).toBe(join(project, ".afterpack"));
  });

  it("refuses a home that would sit inside the build dir", () => {
    expect(() => afterpackHome("/")).toThrow(/inside the build output/);
  });
});
