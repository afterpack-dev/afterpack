import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseSeedValue,
  randomSeed,
  resetBuildSessions,
  resolveBuildSeed,
  SEED_ENV_VAR,
} from "./seed.js";

describe("randomSeed", () => {
  it("returns a JSON-safe, non-negative integer", () => {
    for (let i = 0; i < 100; i++) {
      const s = randomSeed();
      expect(Number.isSafeInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("resolveBuildSeed — the cross-bundle build-seed contract", () => {
  const ENV = () => ({}) as Record<string, string | undefined>;
  beforeEach(() => resetBuildSessions());
  afterEach(() => resetBuildSessions());

  it("every leg of one build shares ONE fresh seed, drawn once", () => {
    let n = 0;
    const deps = { randomSeed: () => ++n * 1000, env: ENV() };
    const main = resolveBuildSeed(undefined, { root: "/app", leg: "main" }, deps);
    const preload = resolveBuildSeed(undefined, { root: "/app", leg: "preload" }, deps);
    const renderer = resolveBuildSeed(undefined, { root: "/app", leg: "renderer" }, deps);

    expect(main.seed).toBe(1000);
    expect(preload.seed).toBe(1000);
    expect(renderer.seed).toBe(1000);
    expect(n).toBe(1);
    expect([main.origin, preload.origin, renderer.origin]).toEqual(["fresh", "session", "session"]);
    expect(renderer.legs).toEqual(["main", "preload", "renderer"]);
  });

  it("publishes a freshly drawn seed into env so descendant processes inherit it", () => {
    const env = ENV();
    resolveBuildSeed(undefined, { root: "/app", leg: "main" }, { randomSeed: () => 4242, env });
    expect(env[SEED_ENV_VAR]).toBe("4242");
  });

  it("an ancestor-set env var wins over the session and is coerced like --seed", () => {
    const env = { [SEED_ENV_VAR]: "778899" };
    const a = resolveBuildSeed(undefined, { root: "/app", leg: "main" }, { env });
    expect(a).toMatchObject({ seed: 778899, origin: "env" });
    const b = resolveBuildSeed(undefined, { root: "/app", leg: "renderer" }, { env });
    expect(b.seed).toBe(778899);
    const text = resolveBuildSeed(
      undefined,
      { root: "/other", leg: "x" },
      { env: { [SEED_ENV_VAR]: "v1.2.3" } },
    );
    expect(text).toMatchObject({ seed: "v1.2.3", origin: "env" });
  });

  it("does NOT read back its OWN export as an ancestor pin (that would defeat rotation)", () => {
    let n = 0;
    const deps = { randomSeed: () => ++n * 11, env: ENV() };
    const first = resolveBuildSeed(undefined, { root: "/app", leg: "main" }, deps);
    const second = resolveBuildSeed(undefined, { root: "/app", leg: "main" }, deps);
    expect(first).toMatchObject({ seed: 11, origin: "fresh", generation: 1 });
    expect(second).toMatchObject({ seed: 22, origin: "fresh", generation: 2 });
    expect(deps.env[SEED_ENV_VAR]).toBe("22");
  });

  it("re-entry of a leg rotates the WHOLE build's seed (a watch rebuild is a new build)", () => {
    let n = 0;
    const deps = { randomSeed: () => ++n * 100, env: ENV() };
    resolveBuildSeed(undefined, { root: "/app", leg: "main" }, deps);
    resolveBuildSeed(undefined, { root: "/app", leg: "renderer" }, deps);
    const again = resolveBuildSeed(undefined, { root: "/app", leg: "main" }, deps);
    const rendererAgain = resolveBuildSeed(undefined, { root: "/app", leg: "renderer" }, deps);
    expect(again).toMatchObject({ seed: 200, generation: 2 });
    expect(rendererAgain).toMatchObject({ seed: 200, origin: "session", generation: 2 });
  });

  it("distinct project roots never share a seed, even in one process", () => {
    let n = 0;
    const env = ENV();
    const deps = { randomSeed: () => ++n * 7, env };
    const a = resolveBuildSeed(undefined, { root: "/app-a", leg: "client" }, deps);
    const b = resolveBuildSeed(undefined, { root: "/app-b", leg: "client" }, deps);
    expect(a.seed).toBe(7);
    expect(b.seed).toBe(14);
  });

  it("an explicit seed wins on every rung and never becomes the session seed", () => {
    const deps = { randomSeed: () => 555, env: { [SEED_ENV_VAR]: "999" } };
    expect(resolveBuildSeed(12345, { root: "/app", leg: "main" }, deps)).toMatchObject({
      seed: 12345,
      origin: "option",
    });
    expect(resolveBuildSeed("v9", { root: "/app", leg: "preload" }, deps)).toMatchObject({
      seed: "v9",
      origin: "option",
    });
  });

  it('"git" still resolves from HEAD, identically for every leg', () => {
    const head = "9f7a8ffdeadbeef0000000000000000000000000";
    const deps = { gitHead: () => head, env: ENV() };
    expect(resolveBuildSeed("git", { root: "/app", leg: "main" }, deps)).toMatchObject({
      seed: head,
      origin: "git",
    });
    expect(resolveBuildSeed("git", { root: "/app", leg: "renderer" }, deps).seed).toBe(head);
  });

  it('"git" with no repo falls back to ONE shared seed and ONE notice per build', () => {
    const warnings: string[] = [];
    let n = 0;
    const deps = {
      gitHead: () => null,
      randomSeed: () => ++n * 3,
      warn: (m: string) => warnings.push(m),
      env: ENV(),
    };
    const a = resolveBuildSeed("git", { root: "/app", leg: "main" }, deps);
    const b = resolveBuildSeed("git", { root: "/app", leg: "renderer" }, deps);
    expect(a.seed).toBe(3);
    expect(b.seed).toBe(3);
    expect(warnings).toHaveLength(1);
  });

  it("reports a mismatch when only ONE leg pinned a seed", () => {
    const deps = { randomSeed: () => 4321, env: ENV() };
    resolveBuildSeed(12345, { root: "/app", leg: "main" }, deps);
    const renderer = resolveBuildSeed(undefined, { root: "/app", leg: "renderer" }, deps);
    expect(renderer.seed).toBe(4321);
    expect(renderer.mismatch).toEqual({ leg: "main", seed: 12345 });
  });

  it("reports NO mismatch when the legs agree", () => {
    const deps = { env: ENV() };
    resolveBuildSeed(12345, { root: "/app", leg: "main" }, deps);
    expect(resolveBuildSeed(12345, { root: "/app", leg: "renderer" }, deps).mismatch).toBeNull();
  });

  it("resetBuildSessions un-exports the env var it published", () => {
    const env = ENV();
    resolveBuildSeed(undefined, { root: "/app", leg: "main" }, { randomSeed: () => 1, env });
    expect(env[SEED_ENV_VAR]).toBe("1");
    resetBuildSessions();
    expect(env[SEED_ENV_VAR]).toBeUndefined();
  });
});

describe("parseSeedValue", () => {
  it("coerces an integer literal to a number and leaves anything else a string", () => {
    expect(parseSeedValue("42")).toBe(42);
    expect(parseSeedValue("-7")).toBe(-7);
    expect(parseSeedValue("v1.2.3")).toBe("v1.2.3");
    expect(parseSeedValue("1.5")).toBe("1.5");
  });
});
