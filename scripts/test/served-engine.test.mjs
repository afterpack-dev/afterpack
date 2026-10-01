import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { releaseOf, servedEngineProblems } from "../lib/engine.mjs";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const served = (fields) => ({
  version: "v1",
  engineVersion: "0.2.2",
  engineSourceSha: SHA,
  engineSourceDirty: false,
  ...fields,
});
const candidate = { version: "0.2.2-rc.202610011200", sha: SHA };

describe("the engine an API serves for a candidate", () => {
  it("is the candidate's when it is built clean from the candidate's commit at its release", () => {
    assert.deepEqual(servedEngineProblems(served({}), candidate), []);
    assert.deepEqual(servedEngineProblems(served({}), { ...candidate, version: "0.2.2" }), []);
  });

  it("is not when it is built from another commit", () => {
    assert.deepEqual(servedEngineProblems(served({ engineSourceSha: OTHER }), candidate), [
      `the API serves the engine built from ${OTHER}, not the candidate's ${SHA}`,
    ]);
    assert.deepEqual(servedEngineProblems(served({ engineSourceSha: null }), candidate), [
      `the API serves the engine built from an unknown commit, not the candidate's ${SHA}`,
    ]);
  });

  it("is not when its tree was dirty or does not say", () => {
    for (const engineSourceDirty of [true, undefined]) {
      assert.deepEqual(servedEngineProblems(served({ engineSourceDirty }), candidate), [
        "the API does not report its engine as built from a clean tree",
      ]);
    }
  });

  it("is not when its version is another release", () => {
    assert.deepEqual(servedEngineProblems(served({ engineVersion: "0.2.1" }), candidate), [
      "the API's engine is version 0.2.1, not 0.2.2",
    ]);
  });

  it("is not when the API answered nothing", () => {
    assert.deepEqual(servedEngineProblems(null, candidate), [
      "the API answered no version document",
    ]);
  });

  it("refuses a candidate that is not a version and a commit", () => {
    assert.deepEqual(servedEngineProblems(served({}), { ...candidate, version: "latest" }), [
      "'latest' is not a version",
    ]);
    assert.deepEqual(servedEngineProblems(served({}), { ...candidate, sha: "ce3b695" }), [
      "'ce3b695' is not a 40-character commit sha",
    ]);
  });

  it("names a candidate's release without its prerelease or build", () => {
    assert.equal(releaseOf("0.2.2-rc.202610011200"), "0.2.2");
    assert.equal(releaseOf("0.2.2+build.7"), "0.2.2");
    assert.equal(releaseOf("1.0.0"), "1.0.0");
  });
});
