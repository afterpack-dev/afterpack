import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectCliSourceType, htmlScriptKinds } from "../src/source-type.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "afterpack-source-type-"));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const target = join(root, name);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, contents);
  }
  return root;
}

describe("htmlScriptKinds", () => {
  it("recognises module scripts with a src in any attribute order", () => {
    expect(htmlScriptKinds('<script type="module" src="/a.js"></script>')).toEqual({
      module: true,
      classic: false,
    });
    expect(htmlScriptKinds("<script src='/a.js' type=module></script>")).toEqual({
      module: true,
      classic: false,
    });
  });

  it("recognises classic scripts and inline modules", () => {
    expect(htmlScriptKinds('<script src="/a.js"></script>')).toEqual({
      module: false,
      classic: true,
    });
    expect(htmlScriptKinds('<script type="text/javascript" src="/a.js"></script>')).toEqual({
      module: false,
      classic: true,
    });
    expect(htmlScriptKinds('<script type="module">import "x";</script>')).toEqual({
      module: false,
      classic: false,
    });
    expect(htmlScriptKinds('<script type="application/json" src="/d.json"></script>')).toEqual({
      module: false,
      classic: false,
    });
    expect(htmlScriptKinds('<script type="text/ecmascript" src="/a.js"></script>')).toEqual({
      module: false,
      classic: true,
    });
  });

  it("does not read data-src or data-type as src or type", () => {
    expect(htmlScriptKinds('<script data-src="/a.js"></script>')).toEqual({
      module: false,
      classic: false,
    });
    expect(htmlScriptKinds('<script data-type="module" src="/a.js"></script>')).toEqual({
      module: false,
      classic: true,
    });
    expect(
      htmlScriptKinds('<script src="/a.js" data-type="text/javascript" type="module">'),
    ).toEqual({ module: true, classic: false });
  });
});

describe("detectCliSourceType", () => {
  it("is module when every file is .mjs", () => {
    const root = project({ "dist/a.mjs": "export const a = 1;" });
    expect(
      detectCliSourceType({ files: [join(root, "dist/a.mjs")], buildDir: join(root, "dist") }),
    ).toBe("module");
  });

  it("does not label a classic IIFE build module just because package.json is type module", () => {
    const root = project({
      "package.json": '{ "type": "module" }',
      "dist/a.js": "(function () { window.x = 1; })();",
    });
    expect(
      detectCliSourceType({ files: [join(root, "dist/a.js")], buildDir: join(root, "dist") }),
    ).toBeUndefined();
  });

  it("is unset when a .cjs file is in the batch", () => {
    const root = project({
      "dist/a.js": "export const a = 1;",
      "dist/b.cjs": "module.exports = 1;",
    });
    expect(
      detectCliSourceType({
        files: [join(root, "dist/a.js"), join(root, "dist/b.cjs")],
        buildDir: join(root, "dist"),
      }),
    ).toBeUndefined();
  });

  it("is module when built HTML loads scripts only as modules", () => {
    const root = project({
      "dist/index.html": '<script type="module" src="/app.js"></script>',
      "dist/app.js": "export const a = 1;",
    });
    expect(
      detectCliSourceType({ files: [join(root, "dist/app.js")], buildDir: join(root, "dist") }),
    ).toBe("module");
  });

  it("is unset when built HTML also loads a classic script", () => {
    const root = project({
      "dist/index.html":
        '<script type="module" src="/app.js"></script><script src="/legacy.js"></script>',
      "dist/app.js": "export const a = 1;",
      "dist/legacy.js": "var x = 1;",
    });
    expect(
      detectCliSourceType({
        files: [join(root, "dist/app.js"), join(root, "dist/legacy.js")],
        buildDir: join(root, "dist"),
      }),
    ).toBeUndefined();
  });

  it("is unset when a batch file is not loaded as a module script", () => {
    const root = project({
      "dist/index.html": '<script type="module" src="/app.js"></script>',
      "dist/app.js": "export const a = 1;",
      "dist/worker.js": "self.onmessage = () => {};",
    });
    expect(
      detectCliSourceType({
        files: [join(root, "dist/app.js"), join(root, "dist/worker.js")],
        buildDir: join(root, "dist"),
      }),
    ).toBeUndefined();
  });

  it("is unset for a plain .js build with no module signal", () => {
    const root = project({ "dist/a.js": "var a = 1;" });
    expect(
      detectCliSourceType({ files: [join(root, "dist/a.js")], buildDir: join(root, "dist") }),
    ).toBeUndefined();
  });

  it("is unset for an empty file list", () => {
    const root = project({});
    expect(detectCliSourceType({ files: [], buildDir: root })).toBeUndefined();
  });
});
