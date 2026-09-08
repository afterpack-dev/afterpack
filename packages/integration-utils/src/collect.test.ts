import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectJsFiles, collectSourceMaps } from "./collect.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "afterpack-collect-test-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function rel(files: string[]): string[] {
  return files.map((f) => relative(root, f)).sort();
}

describe("collectJsFiles", () => {
  it("recurses and collects .js/.mjs/.cjs, ignoring non-JS files", () => {
    mkdirSync(join(root, "nested"), { recursive: true });
    writeFileSync(join(root, "a.js"), "1");
    writeFileSync(join(root, "b.mjs"), "2");
    writeFileSync(join(root, "nested", "c.cjs"), "3");
    writeFileSync(join(root, "styles.css"), "x");
    writeFileSync(join(root, "data.json"), "{}");

    expect(rel(collectJsFiles(root))).toEqual(["a.js", "b.mjs", join("nested", "c.cjs")]);
  });

  it("skips AfterPack's own .backup.<hash> copies (never re-obfuscate a backup)", () => {
    writeFileSync(join(root, "a.js"), "1");
    writeFileSync(join(root, "a.backup.deadbeef.js"), "orig");
    writeFileSync(join(root, "a.js.map"), "{}");

    expect(rel(collectJsFiles(root))).toEqual(["a.js"]);
  });

  it("returns [] for a missing directory", () => {
    expect(collectJsFiles(join(root, "does-not-exist"))).toEqual([]);
  });

  it("accepts a single FILE target and returns just that file", () => {
    const file = join(root, "app.js");
    writeFileSync(file, "1");
    writeFileSync(join(root, "other.js"), "2");
    expect(collectJsFiles(file)).toEqual([file]);
    const mjs = join(root, "esm.mjs");
    writeFileSync(mjs, "3");
    expect(collectJsFiles(mjs)).toEqual([mjs]);
    const cjs = join(root, "old.cjs");
    writeFileSync(cjs, "4");
    expect(collectJsFiles(cjs)).toEqual([cjs]);
  });

  it("returns [] for a FILE target that is not obfuscatable JS (extension or backup)", () => {
    writeFileSync(join(root, "styles.css"), "x");
    writeFileSync(join(root, "a.backup.deadbeef.js"), "orig");
    writeFileSync(join(root, "a.js.map"), "{}");
    expect(collectJsFiles(join(root, "styles.css"))).toEqual([]);
    expect(collectJsFiles(join(root, "a.backup.deadbeef.js"))).toEqual([]);
    expect(collectJsFiles(join(root, "a.js.map"))).toEqual([]);
    expect(collectJsFiles(join(root, "nope.js"))).toEqual([]);
  });

  it("skips nested node_modules/ by default and on an include that names something else", () => {
    mkdirSync(join(root, "node_modules", "left-pad"), { recursive: true });
    mkdirSync(join(root, "vendor", "node_modules"), { recursive: true });
    writeFileSync(join(root, "app.js"), "1");
    writeFileSync(join(root, "node_modules", "left-pad", "index.js"), "2");
    writeFileSync(join(root, "vendor", "node_modules", "dep.cjs"), "3");

    expect(rel(collectJsFiles(root))).toEqual(["app.js"]);
    expect(rel(collectJsFiles(root, { include: [] }))).toEqual(["app.js"]);
    expect(rel(collectJsFiles(root, { include: ["**/*.min.js"] }))).toEqual(["app.js"]);
  });

  it("walks every nested node_modules/ on the documented paths.include glob", () => {
    mkdirSync(join(root, "node_modules", "left-pad"), { recursive: true });
    mkdirSync(join(root, "vendor", "node_modules"), { recursive: true });
    writeFileSync(join(root, "app.js"), "1");
    writeFileSync(join(root, "node_modules", "left-pad", "index.js"), "2");
    writeFileSync(join(root, "vendor", "node_modules", "dep.cjs"), "3");

    expect(rel(collectJsFiles(root, { include: ["**/node_modules/**"] }))).toEqual([
      "app.js",
      join("node_modules", "left-pad", "index.js"),
      join("vendor", "node_modules", "dep.cjs"),
    ]);
  });

  it("takes only what the include glob names inside a re-admitted node_modules/", () => {
    mkdirSync(join(root, "node_modules", "left-pad"), { recursive: true });
    mkdirSync(join(root, "node_modules", "other-dep"), { recursive: true });
    writeFileSync(join(root, "app.js"), "1");
    writeFileSync(join(root, "node_modules", "left-pad", "index.js"), "2");
    writeFileSync(join(root, "node_modules", "other-dep", "index.js"), "3");

    expect(rel(collectJsFiles(root, { include: ["**/node_modules/left-pad/**"] }))).toEqual([
      "app.js",
      join("node_modules", "left-pad", "index.js"),
    ]);
  });

  it("leaves the walk outside a skip alone, whatever paths.include holds", () => {
    mkdirSync(join(root, "nested"), { recursive: true });
    writeFileSync(join(root, "app.js"), "1");
    writeFileSync(join(root, "nested", "c.cjs"), "2");

    expect(rel(collectJsFiles(root, { include: ["**/node_modules/**"] }))).toEqual([
      "app.js",
      join("nested", "c.cjs"),
    ]);
  });

  it("still walks a node_modules directory named as the target itself", () => {
    mkdirSync(join(root, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(root, "node_modules", "left-pad", "index.js"), "1");
    expect(rel(collectJsFiles(join(root, "node_modules")))).toEqual([
      join("node_modules", "left-pad", "index.js"),
    ]);
  });
});

describe("collectSourceMaps", () => {
  it("recurses and collects only .js.map/.mjs.map/.cjs.map, not JS or other files", () => {
    mkdirSync(join(root, "nested"), { recursive: true });
    writeFileSync(join(root, "a.js"), "1");
    writeFileSync(join(root, "a.js.map"), "{}");
    writeFileSync(join(root, "b.mjs.map"), "{}");
    writeFileSync(join(root, "nested", "c.cjs.map"), "{}");
    writeFileSync(join(root, "styles.css.map"), "x");

    expect(rel(collectSourceMaps(root))).toEqual([
      "a.js.map",
      "b.mjs.map",
      join("nested", "c.cjs.map"),
    ]);
  });

  it("returns [] for a missing directory", () => {
    expect(collectSourceMaps(join(root, "does-not-exist"))).toEqual([]);
  });
});
