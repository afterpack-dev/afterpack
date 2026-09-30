import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  applyEngineBump,
  breakingLine,
  COMPAT_FILE,
  compareVersions,
  lineStart,
  planEngineBump,
  readRepo,
} from "../lib/bump.mjs";

function repo({ root = "0.2.0", pin = "~0.2.0", minCore = "0.2.0" } = {}) {
  return {
    rootVersion: root,
    minCore,
    packages: [
      { dir: "packages/cli", pkg: { name: "afterpack", dependencies: { "@afterpack/core": pin } } },
      { dir: "packages/utils", pkg: { name: "@afterpack/integration-utils" } },
    ],
  };
}

describe("version arithmetic", () => {
  it("treats a minor as breaking under major 0, and a major above it", () => {
    assert.equal(breakingLine("0.2.9"), "0.2");
    assert.equal(breakingLine("1.4.0"), "1");
    assert.equal(lineStart("0.3.7"), "0.3.0");
    assert.equal(lineStart("2.5.1"), "2.0.0");
    assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
    assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  });
});

describe("planEngineBump", () => {
  it("repins a patch and leaves the floors alone", () => {
    const plan = planEngineBump(repo(), "0.2.1");
    assert.equal(plan.changed, true);
    assert.equal(plan.range, "~0.2.1");
    assert.equal(plan.lineChanged, false);
    assert.equal(plan.floor, "0.2.0");
    assert.equal(plan.minCore, "0.2.0");
  });

  it("carries a minor under major 0 into the package floor and the runtime floor", () => {
    const plan = planEngineBump(repo(), "0.3.0");
    assert.equal(plan.range, "~0.3.0");
    assert.equal(plan.lineChanged, true);
    assert.equal(plan.floor, "0.3.0");
    assert.equal(plan.minCore, "0.3.0");
  });

  it("moves to 1.0.0 the same way, and treats a minor above 1 as compatible", () => {
    assert.equal(planEngineBump(repo(), "1.0.0").floor, "1.0.0");
    const minor = planEngineBump(repo({ root: "1.2.0", pin: "~1.2.3", minCore: "1.0.0" }), "1.3.0");
    assert.equal(minor.lineChanged, false);
    assert.equal(minor.floor, "1.2.0");
    assert.equal(minor.minCore, "1.0.0");
  });

  it("never lowers a floor that is already higher", () => {
    const plan = planEngineBump(repo({ root: "0.4.0", pin: "~0.2.4" }), "0.3.0");
    assert.equal(plan.floor, "0.4.0");
  });

  it("is a no-op when the pin already names the version", () => {
    const plan = planEngineBump(repo({ pin: "~0.2.1" }), "0.2.1");
    assert.equal(plan.changed, false);
    assert.match(plan.reason, /already pinned to ~0\.2\.1/);
  });

  it("never downgrades", () => {
    const plan = planEngineBump(repo({ pin: "~0.3.1" }), "0.3.0");
    assert.equal(plan.changed, false);
    assert.match(plan.reason, /newer than 0\.3\.0/);
  });

  it("refuses a prerelease and a repository with no engine dependency", () => {
    assert.throws(() => planEngineBump(repo(), "0.3.0-rc.1"), /not a stable version/);
    const none = { ...repo(), packages: [{ dir: "packages/x", pkg: { name: "x" } }] };
    assert.throws(() => planEngineBump(none, "0.3.0"), /no package depends/);
  });
});

describe("applyEngineBump", () => {
  let root;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  function write(file, value) {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(
      full,
      typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
    );
  }

  function tree() {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "bump-engine-"));
    write("package.json", { name: "monorepo", version: "0.2.0", private: true });
    write("packages/cli/package.json", {
      name: "afterpack",
      version: "0.2.0",
      dependencies: { "@afterpack/core": "~0.2.0", "@afterpack/integration-utils": "workspace:*" },
    });
    write("packages/vite/package.json", {
      name: "@afterpack/vite",
      version: "0.2.0",
      peerDependencies: { vite: ">=5" },
      dependencies: { "@afterpack/core": "~0.2.0" },
    });
    write("packages/fixture/package.json", { name: "fixture", version: "0.0.1", private: true });
    write(
      COMPAT_FILE,
      'import x from "y";\n\nexport const MIN_CORE_VERSION = "0.2.0";\n\nexport const CORE_PACKAGE = "@afterpack/core";\n',
    );
  }

  const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));

  it("rewrites the ranges, the package versions and MIN_CORE_VERSION on a new line", () => {
    tree();
    const written = applyEngineBump(root, planEngineBump(readRepo(root), "0.3.0"));
    assert.deepEqual(written, [
      "package.json",
      "packages/cli/package.json",
      "packages/vite/package.json",
      COMPAT_FILE,
    ]);
    assert.equal(read("package.json").version, "0.3.0");
    assert.equal(read("packages/cli/package.json").dependencies["@afterpack/core"], "~0.3.0");
    assert.equal(
      read("packages/cli/package.json").dependencies["@afterpack/integration-utils"],
      "workspace:*",
    );
    assert.equal(read("packages/vite/package.json").version, "0.3.0");
    assert.equal(read("packages/fixture/package.json").version, "0.0.1");
    assert.match(
      fs.readFileSync(path.join(root, COMPAT_FILE), "utf8"),
      /export const MIN_CORE_VERSION = "0\.3\.0";\n\nexport const CORE_PACKAGE/,
    );
  });

  it("touches only the ranges on a patch, and nothing the second time", () => {
    tree();
    const first = applyEngineBump(root, planEngineBump(readRepo(root), "0.2.1"));
    assert.deepEqual(first, ["packages/cli/package.json", "packages/vite/package.json"]);
    assert.equal(read("packages/cli/package.json").version, "0.2.0");
    const again = planEngineBump(readRepo(root), "0.2.1");
    assert.equal(again.changed, false);
    assert.deepEqual(applyEngineBump(root, again), []);
  });

  it("fails when compat.ts no longer declares the runtime floor", () => {
    tree();
    write(COMPAT_FILE, "export const MIN = 1;\n");
    assert.throws(() => readRepo(root), /no longer declares MIN_CORE_VERSION/);
  });
});
