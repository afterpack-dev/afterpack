import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  compareManifests,
  hostIsMusl,
  isInside,
  listFixtures,
  loadedAddons,
  normalizeSource,
  PRESETS,
  readFixture,
  resultKey,
  runNode,
  SEEDS,
} from "../lib/smoke.mjs";

const FIXTURES = path.join(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  "smoke-fixtures",
);

describe("the fixture set", () => {
  it("is every script and module in smoke-fixtures, in a stable order", () => {
    const fixtures = listFixtures(FIXTURES);
    assert.deepEqual(fixtures, [...fixtures].sort());
    assert.ok(fixtures.length >= 5);
    assert.ok(fixtures.some((name) => name.endsWith(".mjs")));
    assert.ok(fixtures.some((name) => name.endsWith(".cjs")));
  });

  it("runs unprotected and prints something on every fixture", () => {
    for (const fixture of listFixtures(FIXTURES)) {
      const result = runNode([path.join(FIXTURES, fixture)], FIXTURES);
      assert.equal(result.status, 0, `${fixture}: ${result.stderr}`);
      assert.ok(result.stdout.trim().length > 0, fixture);
    }
  });

  it("covers every preset twice", () => {
    assert.deepEqual(PRESETS, ["minify", "light", "medium", "hard", "extreme"]);
    assert.equal(SEEDS.length, 2);
    assert.equal(resultKey("a.cjs", "hard", 2), "a.cjs@hard#2");
  });

  it("reads a checkout with CRLF line endings as the same source", () => {
    assert.equal(normalizeSource("a\r\nb\r\n"), "a\nb\n");
    const name = listFixtures(FIXTURES)[0];
    assert.ok(!readFixture(FIXTURES, name).includes("\r"));
  });
});

describe("compareManifests", () => {
  const golden = { inputs: { "a.cjs": "i1" }, results: { "a.cjs@light#1": "h1" } };

  it("is empty when every hash matches", () => {
    assert.deepEqual(compareManifests(golden, structuredClone(golden)), []);
  });

  it("names a different, a missing and an extra hash", () => {
    const actual = {
      inputs: { "a.cjs": "i2" },
      results: { "a.cjs@hard#1": "h9" },
    };
    assert.deepEqual(compareManifests(golden, actual), [
      "inputs a.cjs: i2 here, i1 in the golden run",
      "results a.cjs@light#1: missing here",
      "results a.cjs@hard#1: not in the golden run",
    ]);
  });
});

describe("host detection", () => {
  it("reads musl from a Linux report with no glibc runtime", () => {
    assert.equal(hostIsMusl("linux", { header: {} }), true);
    assert.equal(hostIsMusl("linux", { header: { glibcVersionRuntime: "2.39" } }), false);
    assert.equal(hostIsMusl("darwin", { header: {} }), false);
  });

  it("finds the native addons node loaded", () => {
    assert.deepEqual(loadedAddons({ "/a/b.js": 1, "/a/x.node": 1, "/c/y.node": 1 }), [
      "/a/x.node",
      "/c/y.node",
    ]);
  });

  it("tells whether a file sits inside a directory, through symlinks", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-inside-"));
    try {
      fs.mkdirSync(path.join(dir, "pkg"));
      fs.writeFileSync(path.join(dir, "pkg", "a.node"), "");
      fs.writeFileSync(path.join(dir, "b.node"), "");
      fs.symlinkSync(path.join(dir, "pkg"), path.join(dir, "link"), "junction");
      assert.equal(isInside(path.join(dir, "pkg", "a.node"), path.join(dir, "link")), true);
      assert.equal(isInside(path.join(dir, "b.node"), path.join(dir, "pkg")), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
