import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BINDINGS,
  bindingPackage,
  checkEngineManifest,
  ENGINE_PACKAGES,
  EXPECTED_REPOSITORY,
  hostBinding,
  payloadIntegrity,
  resolveEngineRelease,
} from "../lib/engine.mjs";

describe("the engine package set", () => {
  it("is the seven native bindings, the wasm build and the core", () => {
    assert.equal(Object.keys(BINDINGS).length, 7);
    assert.equal(ENGINE_PACKAGES.length, 9);
    assert.ok(ENGINE_PACKAGES.includes("@afterpack/core-win32-x64-msvc"));
    assert.ok(ENGINE_PACKAGES.includes("@afterpack/wasm"));
    assert.equal(bindingPackage("linux-arm64-musl"), "@afterpack/core-linux-arm64-musl");
  });

  it("maps a host to exactly one binding", () => {
    assert.equal(hostBinding({ platform: "darwin", arch: "arm64", musl: false }), "darwin-arm64");
    assert.equal(hostBinding({ platform: "linux", arch: "x64", musl: true }), "linux-x64-musl");
    assert.equal(hostBinding({ platform: "linux", arch: "x64", musl: false }), "linux-x64-gnu");
    assert.equal(hostBinding({ platform: "win32", arch: "arm64", musl: false }), null);
  });
});

describe("resolveEngineRelease", () => {
  it("takes the dispatch payload, stripping a leading v and defaulting to latest", () => {
    assert.deepEqual(
      resolveEngineRelease({ event: "repository_dispatch", payload: { version: "v0.3.0" } }),
      { version: "0.3.0", tag: "latest", fromDispatch: true },
    );
    assert.equal(
      resolveEngineRelease({
        event: "repository_dispatch",
        payload: { version: "0.3.0", tag: "rc" },
      }).tag,
      "rc",
    );
  });

  it("takes the inputs of a manual run", () => {
    assert.deepEqual(
      resolveEngineRelease({ event: "workflow_dispatch", inputVersion: "0.2.1", inputTag: "" }),
      { version: "0.2.1", tag: "latest", fromDispatch: false },
    );
  });

  it("refuses a prerelease, a malformed version and an unknown dist-tag", () => {
    for (const version of ["0.3.0-rc.1", "0.3", "", undefined]) {
      assert.throws(
        () => resolveEngineRelease({ event: "workflow_dispatch", inputVersion: version }),
        /is not a stable version/,
      );
    }
    assert.throws(
      () =>
        resolveEngineRelease({
          event: "repository_dispatch",
          payload: { version: "0.3.0", tag: "beta" },
        }),
      /not latest or rc/,
    );
  });
});

describe("payloadIntegrity", () => {
  it("finds a package's integrity, or nothing", () => {
    const payload = { packages: [{ name: "@afterpack/core", integrity: "sha512-x" }, null] };
    assert.equal(payloadIntegrity(payload, "@afterpack/core"), "sha512-x");
    assert.equal(payloadIntegrity(payload, "@afterpack/wasm"), null);
    assert.equal(payloadIntegrity(null, "@afterpack/core"), null);
  });
});

describe("checkEngineManifest", () => {
  const good = {
    name: "@afterpack/core",
    version: "0.3.0",
    repository: { url: EXPECTED_REPOSITORY },
  };

  it("accepts the package it expects", () => {
    assert.deepEqual(checkEngineManifest(good, "@afterpack/core", "0.3.0"), []);
  });

  it("names a wrong package, version or repository", () => {
    assert.equal(checkEngineManifest(good, "@afterpack/wasm", "0.3.0").length, 1);
    assert.equal(checkEngineManifest(good, "@afterpack/core", "0.3.1").length, 1);
    assert.match(
      checkEngineManifest({ ...good, repository: undefined }, "@afterpack/core", "0.3.0")[0],
      /repository\.url is ''/,
    );
  });
});
