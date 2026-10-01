import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import {
  alreadyPublished,
  integrityOf,
  npmrcFor,
  packFilename,
  packumentUrl,
  publishedDifferences,
  publishOrder,
  registryHost,
  tarballDifferences,
  tarballUrl,
  versionUrl,
  waitUntilServed,
} from "../lib/registry.mjs";

const REAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

describe("registry URLs", () => {
  it("name the tarball the way npmjs serves it", () => {
    assert.equal(
      tarballUrl("@afterpack/core-darwin-arm64", "0.2.1"),
      "https://registry.npmjs.org/@afterpack/core-darwin-arm64/-/core-darwin-arm64-0.2.1.tgz",
    );
    assert.equal(
      tarballUrl("afterpack", "0.3.0"),
      "https://registry.npmjs.org/afterpack/-/afterpack-0.3.0.tgz",
    );
  });

  it("ask for one version document, never the whole version list", () => {
    assert.equal(
      versionUrl("@afterpack/core", "0.2.1"),
      "https://registry.npmjs.org/@afterpack/core/0.2.1",
    );
    assert.equal(packumentUrl("@afterpack/core"), "https://registry.npmjs.org/@afterpack%2fcore");
  });
});

describe("alreadyPublished", () => {
  it("accepts the E403 npmjs answers while it still processes a publish", () => {
    const e403 = [
      "npm error code E403",
      "npm error 403 403 Forbidden - PUT https://registry.npmjs.org/@afterpack%2fcore-darwin-arm64 - You cannot publish over the previously published versions: 0.2.1.",
    ].join("\n");
    assert.equal(alreadyPublished(e403), true);
  });

  it("accepts a publish conflict", () => {
    assert.equal(alreadyPublished("npm error code E409\nnpm error 409 Conflict - PUT"), true);
    assert.equal(alreadyPublished("npm ERR! code EPUBLISHCONFLICT"), true);
  });

  it("refuses every other failure, including a 403 for permissions", () => {
    assert.equal(
      alreadyPublished("npm error code E403\nnpm error 403 You do not have permission"),
      false,
    );
    assert.equal(alreadyPublished("npm error code E404\nnpm error 404 Not Found"), false);
    assert.equal(alreadyPublished("npm error code ENEEDAUTH"), false);
  });
});

describe("packFilename", () => {
  it("reads npm 11's array", () => {
    assert.equal(packFilename('[{"filename":"a-1.0.0.tgz"}]'), "a-1.0.0.tgz");
  });

  it("reads a keyed object and a bare entry", () => {
    assert.equal(packFilename('{"a@1.0.0":{"filename":"a-1.0.0.tgz"}}'), "a-1.0.0.tgz");
    assert.equal(packFilename('{"id":"a@1.0.0","filename":"a-1.0.0.tgz"}'), "a-1.0.0.tgz");
  });

  it("fails on output with no filename", () => {
    assert.throws(() => packFilename("[]"), /no filename/);
    assert.throws(() => packFilename('{"a":{}}'), /no filename/);
  });
});

describe("publishOrder", () => {
  it("publishes every dependency before its dependents", () => {
    const order = publishOrder([
      { name: "afterpack", dependencies: { "@afterpack/utils": "1.0.0", "@afterpack/core": "~1" } },
      { name: "@afterpack/core", optionalDependencies: { "@afterpack/core-linux": "1.0.0" } },
      { name: "@afterpack/utils", dependencies: { "@afterpack/map": "1.0.0" } },
      { name: "@afterpack/map" },
      { name: "@afterpack/core-linux" },
    ]).map((m) => m.name);
    assert.deepEqual(order, [
      "@afterpack/core-linux",
      "@afterpack/core",
      "@afterpack/map",
      "@afterpack/utils",
      "afterpack",
    ]);
  });

  it("refuses a cycle", () => {
    assert.throws(
      () =>
        publishOrder([
          { name: "a", dependencies: { b: "1" } },
          { name: "b", peerDependencies: { a: "1" } },
        ]),
      /cycle/,
    );
  });
});

describe("npmrc and hosts", () => {
  it("routes a scope to a host and authenticates only that host", () => {
    const [scopeLine, authLine, rest] = npmrcFor({
      host: "registry.example.test",
      token: "t0k",
      scope: "@afterpack",
    }).split("\n");
    assert.match(scopeLine, /^@afterpack:\w+=https:\/\/registry\.example\.test\/$/);
    assert.match(authLine, /^\/\/registry\.example\.test\/:\w+=t0k$/);
    assert.equal(rest, "");
    assert.equal(npmrcFor({ host: "registry.example.test" }), "\n");
  });

  it("reduces a registry URL to its host", () => {
    assert.equal(registryHost("https://registry.example.test/"), "registry.example.test");
    assert.equal(registryHost(" registry.example.test "), "registry.example.test");
    assert.throws(() => registryHost("https://registry.example.test/sub/path"), /bare/);
    assert.throws(() => registryHost(""), /bare/);
  });

  it("computes npm's integrity string", () => {
    assert.equal(
      integrityOf(Buffer.from("abc")),
      "sha512-3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw==",
    );
  });
});

function fakeRegistry({ servedAfter, bytes = Buffer.from("tarball"), tag = "latest" }) {
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    const served = calls > servedAfter;
    if (String(url).endsWith(".tgz")) {
      return served ? new Response(bytes) : new Response("nope", { status: 404 });
    }
    if (String(url).includes("%2f")) {
      return served
        ? Response.json({ versions: { "1.0.0": {} }, "dist-tags": { [tag]: "1.0.0" } })
        : Response.json({ versions: {}, "dist-tags": {} });
    }
    return served ? Response.json({ version: "1.0.0" }) : new Response("{}", { status: 404 });
  };
}

function clock() {
  let t = 0;
  return {
    now: () => t,
    wait: async (ms) => {
      t += ms;
    },
  };
}

describe("waitUntilServed", () => {
  it("waits until the tarball, the version document and the version list all answer", async () => {
    fakeRegistry({ servedAfter: 6 });
    const time = clock();
    const log = [];
    await waitUntilServed(
      [
        {
          name: "@afterpack/core",
          version: "1.0.0",
          integrity: integrityOf(Buffer.from("tarball")),
          tag: "latest",
        },
      ],
      { ...time, intervalMs: 1000, log: (line) => log.push(line) },
    );
    assert.equal(log.at(-1), "served: @afterpack/core@1.0.0 after 2s");
  });

  it("gives up at the deadline", async () => {
    fakeRegistry({ servedAfter: Number.POSITIVE_INFINITY });
    await assert.rejects(
      waitUntilServed([{ name: "@afterpack/core", version: "1.0.0" }], {
        ...clock(),
        deadlineMs: 5000,
        intervalMs: 1000,
        log: () => {},
      }),
      /still not served after 0.1 min: @afterpack\/core@1.0.0/,
    );
  });

  it("fails at once when the served bytes are not the published ones", async () => {
    fakeRegistry({ servedAfter: 0, bytes: Buffer.from("other bytes") });
    await assert.rejects(
      waitUntilServed(
        [{ name: "@afterpack/core", version: "1.0.0", integrity: integrityOf(Buffer.from("x")) }],
        { ...clock(), log: () => {} },
      ),
      /the tarball on the registry is sha512-/,
    );
  });

  it("waits for the dist-tag only when asked to", async () => {
    fakeRegistry({ servedAfter: 0, tag: "rc" });
    await waitUntilServed([{ name: "@afterpack/core", version: "1.0.0" }], {
      ...clock(),
      log: () => {},
    });
    await assert.rejects(
      waitUntilServed([{ name: "@afterpack/core", version: "1.0.0", tag: "latest" }], {
        ...clock(),
        deadlineMs: 2000,
        intervalMs: 1000,
        log: () => {},
      }),
      /still not served/,
    );
  });
});

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "registry-test-"));

after(() => {
  fs.rmSync(WORK, { recursive: true, force: true });
});

function packTree(label, files, mtime) {
  const root = path.join(WORK, label);
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, "package", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    fs.utimesSync(file, mtime, mtime);
  }
  const file = path.join(WORK, `${label}.tgz`);
  execFileSync("tar", ["-czf", file, "-C", root, "package"]);
  return {
    name: "@afterpack/vite",
    version: "1.0.0",
    file,
    integrity: integrityOf(fs.readFileSync(file)),
  };
}

const FILES = { "package.json": '{"name":"@afterpack/vite"}', "dist/index.js": "export {};" };
const local = packTree("local", FILES, new Date("2020-01-01T00:00:00Z"));
const rebuilt = packTree("rebuilt", FILES, new Date("2021-06-01T00:00:00Z"));
const changed = packTree(
  "changed",
  { ...FILES, "dist/index.js": "export const x = 1;", "dist/extra.js": "" },
  new Date("2020-01-01T00:00:00Z"),
);

function serveTarball(file, status = 200) {
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/@afterpack\/vite\/-\/vite-1\.0\.0\.tgz$/);
    return status === 200 ? new Response(fs.readFileSync(file)) : new Response("", { status });
  };
}

describe("tarballDifferences", () => {
  it("ignores tar metadata and compares the files inside", () => {
    assert.notEqual(local.integrity, rebuilt.integrity);
    assert.deepEqual(tarballDifferences(local.file, rebuilt.file), []);
  });

  it("reads package.json as data, so key order is not a change", () => {
    const reordered = packTree(
      "reordered",
      { ...FILES, "package.json": '{ "version": "1.0.0", "name": "@afterpack/vite" }' },
      new Date("2020-01-01T00:00:00Z"),
    );
    const base = packTree(
      "base",
      { ...FILES, "package.json": '{"name":"@afterpack/vite","version":"1.0.0"}' },
      new Date("2020-01-01T00:00:00Z"),
    );
    const bumped = packTree(
      "bumped",
      { ...FILES, "package.json": '{"name":"@afterpack/vite","version":"1.0.1"}' },
      new Date("2020-01-01T00:00:00Z"),
    );
    assert.deepEqual(tarballDifferences(reordered.file, base.file), []);
    assert.deepEqual(tarballDifferences(bumped.file, base.file), ["~ package.json"]);
  });

  it("names every file that differs, appears or disappears", () => {
    assert.deepEqual(tarballDifferences(changed.file, local.file), [
      "+ dist/extra.js",
      "~ dist/index.js",
    ]);
    assert.deepEqual(tarballDifferences(local.file, changed.file), [
      "- dist/extra.js",
      "~ dist/index.js",
    ]);
  });
});

describe("publishedDifferences", () => {
  it("trusts identical bytes without downloading anything", async () => {
    globalThis.fetch = async () => assert.fail("fetched a tarball with identical bytes");
    assert.deepEqual(await publishedDifferences(local, { integrity: local.integrity }), []);
  });

  it("accepts the same files in other tarball bytes", async () => {
    serveTarball(rebuilt.file);
    assert.deepEqual(await publishedDifferences(local, { integrity: rebuilt.integrity }), []);
  });

  it("reports a different build", async () => {
    serveTarball(changed.file);
    assert.deepEqual(await publishedDifferences(local, { integrity: changed.integrity }), [
      "- dist/extra.js",
      "~ dist/index.js",
    ]);
  });

  it("fails when npmjs lists the version but serves no tarball", async () => {
    serveTarball(changed.file, 404);
    await assert.rejects(
      publishedDifferences(local, { integrity: changed.integrity }),
      /lists it but serves no tarball yet \(404\)/,
    );
  });

  it("fails when the served bytes are not the ones npmjs lists", async () => {
    serveTarball(rebuilt.file);
    await assert.rejects(
      publishedDifferences(local, { integrity: changed.integrity }),
      /not its own sha512-/,
    );
  });
});
