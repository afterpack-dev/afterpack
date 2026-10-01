import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  approvedRcOf,
  BINDINGS,
  bindingPackage,
  checkEngineManifest,
  checkEnginePackage,
  ENGINE_PACKAGES,
  EXPECTED_REPOSITORY,
  hostBinding,
  payloadIntegrity,
  resolveEngineRelease,
  restamped,
  tarballRestampDifferences,
} from "../lib/engine.mjs";
import { describeTarball } from "../lib/registry.mjs";

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
  it("takes the dispatch payload, stripping a leading v", () => {
    assert.deepEqual(
      resolveEngineRelease({ event: "repository_dispatch", payload: { version: "v0.3.0" } }),
      { version: "0.3.0", fromDispatch: true },
    );
  });

  it("takes the inputs of a manual run", () => {
    assert.deepEqual(resolveEngineRelease({ event: "workflow_dispatch", inputVersion: "0.2.1" }), {
      version: "0.2.1",
      fromDispatch: false,
    });
  });

  it("refuses a prerelease and a malformed version", () => {
    for (const version of ["0.3.0-rc.1", "0.3", "", undefined]) {
      assert.throws(
        () => resolveEngineRelease({ event: "workflow_dispatch", inputVersion: version }),
        /is not a stable version/,
      );
    }
  });
});

describe("approvedRcOf", () => {
  it("accepts only a release candidate of the version being published", () => {
    assert.equal(approvedRcOf("0.3.0-rc.202610011200", "0.3.0"), "0.3.0-rc.202610011200");
    for (const rc of ["0.3.1-rc.1", "0.3.0", "0.30.0-rc.1", "0.3.0-rc.", "", undefined]) {
      assert.throws(
        () => approvedRcOf(rc, "0.3.0"),
        /not a release candidate of 0\.3\.0/,
        String(rc),
      );
    }
  });
});

describe("restamped tarballs", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "restamp-test-"));
  after(() => fs.rmSync(work, { recursive: true, force: true }));
  const RC = "0.3.0-rc.202610011200";
  const rcManifest = {
    name: "@afterpack/core",
    version: RC,
    main: "index.js",
    repository: { type: "git", url: "git+https://example.invalid/source.git" },
    optionalDependencies: { "@afterpack/core-linux-x64-gnu": RC },
    dependencies: { "detect-libc": "^2.0.0" },
  };
  const pack = (name, manifest, files) => {
    const dir = path.join(work, name, "package");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
    for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), text);
    const file = path.join(work, `${name}.tgz`);
    execFileSync("tar", ["-czf", file, "-C", path.join(work, name), "package"]);
    return file;
  };
  const files = { "index.js": "module.exports = 1;\n", "engine.node": "\u0000binary" };
  const rc = pack("rc", rcManifest, files);
  const promoted = (manifest, extra = {}) =>
    pack(`stable-${Object.keys(extra).join("-") || "x"}-${Math.random()}`, manifest, {
      ...files,
      ...extra,
    });

  it("accepts the approved RC with only the version restamped, as promote writes it", () => {
    const stable = promoted(restamped(rcManifest, "0.3.0"));
    assert.deepEqual(tarballRestampDifferences(rc, stable, "0.3.0"), []);
    assert.deepEqual(restamped(rcManifest, "0.3.0").optionalDependencies, {
      "@afterpack/core-linux-x64-gnu": "0.3.0",
    });
    assert.equal(restamped(rcManifest, "0.3.0").repository.url, EXPECTED_REPOSITORY);
  });

  it("refuses a doctored file, an added file and a changed manifest", () => {
    const manifest = restamped(rcManifest, "0.3.0");
    assert.deepEqual(
      tarballRestampDifferences(
        rc,
        promoted(manifest, { "index.js": "module.exports = 2;\n" }),
        "0.3.0",
      ),
      ["~ index.js"],
    );
    assert.deepEqual(
      tarballRestampDifferences(rc, promoted(manifest, { "postinstall.js": "x" }), "0.3.0"),
      ["+ postinstall.js"],
    );
    assert.deepEqual(
      tarballRestampDifferences(rc, promoted({ ...manifest, main: "evil.js" }), "0.3.0"),
      ["~ package.json (beyond the version restamp)"],
    );
    assert.deepEqual(
      tarballRestampDifferences(
        rc,
        promoted({ ...manifest, dependencies: { "detect-libc": "*" } }),
        "0.3.0",
      ),
      ["~ package.json (beyond the version restamp)"],
    );
    assert.deepEqual(
      tarballRestampDifferences(rc, promoted(restamped(rcManifest, "0.3.1")), "0.3.0"),
      ["~ package.json (beyond the version restamp)"],
    );
  });

  describe("checkEnginePackage, the check fetch-engine runs on each tarball", () => {
    const check = (stable, overrides = {}) => {
      const asked = [];
      const result = checkEnginePackage({
        name: "@afterpack/core",
        version: "0.3.0",
        rc: RC,
        want: describeTarball(stable).integrity,
        packStable: (spec) => {
          asked.push(`stable ${spec}`);
          return stable;
        },
        packApproved: (spec) => {
          asked.push(`approved ${spec}`);
          return rc;
        },
        ...overrides,
      });
      return { result, asked };
    };

    it("packs the stable and the approved RC, and accepts the RC restamped", () => {
      const { result, asked } = check(promoted(restamped(rcManifest, "0.3.0")));
      assert.deepEqual(asked, ["stable @afterpack/core@0.3.0", `approved @afterpack/core@${RC}`]);
      assert.equal(result.approved, `@afterpack/core@${RC}`);
    });

    it("refuses a stable that is not the approved RC's bytes", () => {
      const doctored = promoted(restamped(rcManifest, "0.3.0"), { "index.js": "evil();\n" });
      assert.throws(
        () => check(doctored),
        new RegExp(
          `^Error: @afterpack/core@0\\.3\\.0 is not the approved @afterpack/core@${RC.replaceAll(".", "\\.")} restamped: ~ index\\.js$`,
        ),
      );
    });

    it("refuses a tarball the release did not name, before it packs the RC", () => {
      const stable = promoted(restamped(rcManifest, "0.3.0"));
      assert.throws(() => check(stable, { want: "sha512-other" }), /integrity mismatch/);
      assert.throws(
        () => check(stable, { want: null }),
        /no integrity for @afterpack\/core@0\.3\.0/,
      );
    });
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
