import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ciGitContext,
  detectGitContext,
  type GitBuildContext,
  localGitContext,
  sanitizeCommitSha,
  sanitizeGitRef,
} from "./git.js";
import { buildContextJson, buildEngineConfig, resolveReportPolicy } from "./policy.js";

const SHA = "3c332a94b80dce02cbefe6dcb641d6763e7a7aed";

function noRepo(): DetectDeps {
  return { env: {}, localGit: () => null };
}
type DetectDeps = Parameters<typeof detectGitContext>[1];

describe("sanitizeCommitSha", () => {
  it("accepts a full and an abbreviated sha, case-folded", () => {
    expect(sanitizeCommitSha(SHA)).toBe(SHA);
    expect(sanitizeCommitSha("3c332a9")).toBe("3c332a9");
    expect(sanitizeCommitSha(`  ${SHA.toUpperCase()}\n`)).toBe(SHA);
  });

  it("DROPS anything that is not a sha", () => {
    for (const bad of [
      "3c332a",
      `${SHA}0`,
      "zzzzzzz",
      "not-a-sha",
      "",
      "   ",
      "3c332a9; rm -rf /",
      "/home/alice/secret-project",
      `${SHA}\r\nContent-Disposition: x`,
      "<script>alert(1)</script>",
    ]) {
      expect(sanitizeCommitSha(bad)).toBeNull();
    }
  });

  it("DROPS a non-string, however plausible", () => {
    for (const bad of [null, undefined, 12345, {}, [SHA], { toString: () => SHA }]) {
      expect(sanitizeCommitSha(bad)).toBeNull();
    }
  });
});

describe("sanitizeGitRef", () => {
  it("accepts the ref shapes CI providers actually set", () => {
    for (const ok of ["main", "feat/git-sha", "release-1.2.3", "v2.0.0", "user/fix_thing+1"]) {
      expect(sanitizeGitRef(ok)).toBe(ok);
    }
    expect(sanitizeGitRef("  main \n")).toBe("main");
  });

  it("DROPS a ref whole rather than truncating or stripping it", () => {
    expect(sanitizeGitRef("a".repeat(201))).toBeNull();
    expect(sanitizeGitRef("a".repeat(200))).toBe("a".repeat(200));
    for (const bad of ["", "   ", "branch with spaces", "br\nanch", "br~anch", "br:anch", "‚"]) {
      expect(sanitizeGitRef(bad)).toBeNull();
    }
  });
});

describe("ciGitContext", () => {
  it("reads each provider's own pair", () => {
    expect(ciGitContext({ GITHUB_SHA: SHA, GITHUB_REF_NAME: "main" })).toEqual({
      commitSha: SHA,
      ref: "main",
    });
    expect(ciGitContext({ CI_COMMIT_SHA: SHA, CI_COMMIT_REF_NAME: "mr/7" })).toEqual({
      commitSha: SHA,
      ref: "mr/7",
    });
    expect(ciGitContext({ VERCEL_GIT_COMMIT_SHA: SHA, VERCEL_GIT_COMMIT_REF: "prod" })).toEqual({
      commitSha: SHA,
      ref: "prod",
    });
    expect(ciGitContext({ CF_PAGES_COMMIT_SHA: SHA, CF_PAGES_BRANCH: "prod" })).toEqual({
      commitSha: SHA,
      ref: "prod",
    });
    expect(ciGitContext({ GIT_COMMIT: SHA, BRANCH_NAME: "trunk" })).toEqual({
      commitSha: SHA,
      ref: "trunk",
    });
  });

  it("never MIXES two providers into a pair that never existed", () => {
    expect(ciGitContext({ GITHUB_SHA: SHA, GIT_COMMIT: "1111111", BRANCH_NAME: "trunk" })).toEqual({
      commitSha: SHA,
    });
  });

  it("returns null when nothing in the env names a build", () => {
    expect(ciGitContext({})).toBeNull();
    expect(ciGitContext({ NODE_ENV: "production", CI: "true" })).toBeNull();
  });

  it("keeps the half that survives when the other is malformed", () => {
    expect(ciGitContext({ GITHUB_SHA: "nonsense", GITHUB_REF_NAME: "main" })).toEqual({
      ref: "main",
    });
    expect(ciGitContext({ GITHUB_SHA: SHA, GITHUB_REF_NAME: "a b" })).toEqual({
      commitSha: SHA,
    });
  });
});

describe("localGitContext", () => {
  it("reads HEAD out of a real repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "afterpack-git-"));
    const run = (...args: string[]): void => {
      execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    };
    run("init", "-b", "trunk");
    run("config", "user.email", "t@example.com");
    run("config", "user.name", "t");
    run("commit", "--allow-empty", "-m", "one");
    const context = localGitContext(dir);
    expect(context?.ref).toBe("trunk");
    expect(context?.commitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns null outside a repository instead of throwing", () => {
    expect(localGitContext(mkdtempSync(join(tmpdir(), "afterpack-nogit-")))).toBeNull();
  });
});

describe("detectGitContext", () => {
  it("prefers explicit config over the env and the repo", () => {
    const explicit: GitBuildContext = { commitSha: SHA, ref: "declared" };
    expect(
      detectGitContext(explicit, {
        env: { GITHUB_SHA: "1111111", GITHUB_REF_NAME: "from-ci" },
        localGit: () => ({ commitSha: "2222222", ref: "from-repo" }),
      }),
    ).toEqual(explicit);
  });

  it("falls through an explicit value that is entirely malformed", () => {
    expect(
      detectGitContext({ commitSha: "nope", ref: "a b" }, { env: { GITHUB_SHA: SHA } }),
    ).toEqual({ commitSha: SHA });
  });

  it("prefers CI env vars over the local repo", () => {
    expect(
      detectGitContext(null, {
        env: { GITHUB_SHA: SHA, GITHUB_REF_NAME: "main" },
        localGit: () => ({ commitSha: "2222222", ref: "from-repo" }),
      }),
    ).toEqual({ commitSha: SHA, ref: "main" });
  });

  it("falls back to the local repository", () => {
    expect(
      detectGitContext(null, { env: {}, localGit: () => ({ commitSha: SHA, ref: "main" }) }),
    ).toEqual({ commitSha: SHA, ref: "main" });
  });

  it("returns null — ABSENT, not empty — when nothing knows", () => {
    const context = detectGitContext(null, noRepo());
    expect(context).toBeNull();
    expect(context).not.toEqual({});
  });
});

describe("the build context a build hands the cloud client", () => {
  const policy = resolveReportPolicy({}, {});

  it("travels on its own lane, never as an engine config key", () => {
    expect(buildContextJson({ commitSha: SHA, ref: "main" })).toBe(
      JSON.stringify({ commitSha: SHA, ref: "main" }),
    );
    const config = buildEngineConfig({ policy });
    expect("git" in config).toBe(false);
    expect(JSON.stringify(config)).not.toContain("git");
  });

  it("carries the client identity as flat keys next to git, never nested", () => {
    expect(
      JSON.parse(
        buildContextJson(
          { commitSha: SHA, ref: "main" },
          { clientVersion: "0.1.0", client: "afterpack/0.1.0" },
        ) ?? "null",
      ),
    ).toEqual({ commitSha: SHA, ref: "main", clientVersion: "0.1.0", client: "afterpack/0.1.0" });
    expect(buildContextJson(null, { clientVersion: "0.1.0", client: null })).toBe(
      JSON.stringify({ clientVersion: "0.1.0" }),
    );
  });

  it("is `undefined` when nothing was detected", () => {
    for (const git of [null, undefined, detectGitContext(null, noRepo())]) {
      expect(buildContextJson(git)).toBeUndefined();
      expect(buildContextJson(git, { clientVersion: null, client: null })).toBeUndefined();
    }
  });
});
