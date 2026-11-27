import { describe, expect, it } from "vitest";
import { detectCiContext, sanitizeCiRunUrl } from "./ci.js";

describe("detectCiContext — one row per CI provider", () => {
  it.each<[string, Record<string, string>, string, string | undefined]>([
    [
      "GitHub Actions",
      {
        GITHUB_ACTIONS: "true",
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "o/r",
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "1",
      },
      "github-actions",
      "https://github.com/o/r/actions/runs/123",
    ],
    [
      "GitLab",
      { GITLAB_CI: "true", CI_JOB_URL: "https://gitlab.com/o/r/-/jobs/9" },
      "gitlab",
      "https://gitlab.com/o/r/-/jobs/9",
    ],
    [
      "CircleCI",
      { CIRCLECI: "true", CIRCLE_BUILD_URL: "https://circleci.com/gh/o/r/7" },
      "circleci",
      "https://circleci.com/gh/o/r/7",
    ],
    [
      "Buildkite",
      { BUILDKITE: "true", BUILDKITE_BUILD_URL: "https://buildkite.com/o/p/builds/5" },
      "buildkite",
      "https://buildkite.com/o/p/builds/5",
    ],
    [
      "Jenkins",
      {
        JENKINS_URL: "https://ci.example.com/",
        BUILD_URL: "https://ci.example.com/job/app/42/",
      },
      "jenkins",
      "https://ci.example.com/job/app/42/",
    ],
    ["Bitbucket Pipelines", { BITBUCKET_BUILD_NUMBER: "17" }, "bitbucket", undefined],
    ["Azure Pipelines", { TF_BUILD: "True" }, "azure-pipelines", undefined],
    ["Vercel", { VERCEL: "1" }, "vercel", undefined],
    ["Netlify", { NETLIFY: "true" }, "netlify", undefined],
    ["Cloudflare Pages", { CF_PAGES: "1" }, "cloudflare-pages", undefined],
  ])("detects %s", (_name, env, ciProvider, ciRunUrl) => {
    const expected = ciRunUrl
      ? { environment: "ci", ciProvider, ciRunUrl }
      : { environment: "ci", ciProvider };
    expect(detectCiContext(env)).toEqual(expected);
    expect(detectCiContext({ ...env, CI: "true" })).toEqual(expected);
  });

  it("links a re-run GitHub attempt to that attempt", () => {
    expect(
      detectCiContext({
        GITHUB_ACTIONS: "true",
        GITHUB_SERVER_URL: "https://github.example.com/",
        GITHUB_REPOSITORY: "o/r",
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "3",
      }).ciRunUrl,
    ).toBe("https://github.example.com/o/r/actions/runs/123/attempts/3");
  });

  it("omits the GitHub link when any part of it is missing or malformed", () => {
    const full = {
      GITHUB_ACTIONS: "true",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "o/r",
      GITHUB_RUN_ID: "123",
    };
    for (const missing of ["GITHUB_SERVER_URL", "GITHUB_REPOSITORY", "GITHUB_RUN_ID"] as const) {
      const env: Record<string, string> = { ...full };
      delete env[missing];
      expect(detectCiContext(env)).toEqual({ environment: "ci", ciProvider: "github-actions" });
    }
    expect(detectCiContext({ ...full, GITHUB_RUN_ID: "12a" }).ciRunUrl).toBeUndefined();
    expect(detectCiContext({ ...full, GITHUB_SERVER_URL: "http://github.com" }).ciRunUrl).toBe(
      undefined,
    );
  });

  it("names the generic provider when only CI is set", () => {
    for (const CI of ["true", "1", "yes"]) {
      expect(detectCiContext({ CI })).toEqual({ environment: "ci", ciProvider: "ci" });
    }
  });

  it("is local with no provider and no link outside CI", () => {
    for (const env of [{}, { CI: "false" }, { CI: "0" }, { CI: "" }, { GITHUB_ACTIONS: "false" }]) {
      expect(detectCiContext(env)).toEqual({ environment: "local" });
    }
  });

  it("never forwards a run link that is not a clean https URL", () => {
    expect(
      detectCiContext({ GITLAB_CI: "true", CI_JOB_URL: "http://gitlab.com/o/r/-/jobs/9" }),
    ).toEqual({ environment: "ci", ciProvider: "gitlab" });
  });
});

describe("sanitizeCiRunUrl", () => {
  it("strips userinfo, query and fragment", () => {
    expect(sanitizeCiRunUrl("https://user:token@ci.example.com/job/1/?token=x#frag")).toBe(
      "https://ci.example.com/job/1/",
    );
  });

  it("refuses anything but https", () => {
    for (const value of [
      "http://ci.example.com/1",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "ftp://ci.example.com/1",
    ]) {
      expect(sanitizeCiRunUrl(value)).toBeNull();
    }
  });

  it("refuses a non-URL, a non-string and an over-long link", () => {
    expect(sanitizeCiRunUrl("not a url")).toBeNull();
    expect(sanitizeCiRunUrl(undefined)).toBeNull();
    expect(sanitizeCiRunUrl(42)).toBeNull();
    const base = "https://ci.example.com/";
    expect(sanitizeCiRunUrl(base + "a".repeat(500 - base.length))).toHaveLength(500);
    expect(sanitizeCiRunUrl(base + "a".repeat(501 - base.length))).toBeNull();
  });
});
