import type { EnvLike } from "./policy.js";

export type BuildEnvironment = "ci" | "local";

export interface CiContext {
  environment: BuildEnvironment;
  ciProvider?: string;
  ciRunUrl?: string;
}

interface CiProvider {
  slug: string;
  detect: string;
  runUrl?: (env: EnvLike) => string | undefined;
}

const MAX_RUN_URL_LENGTH = 500;

const DIGITS = /^[0-9]+$/;

function githubRunUrl(env: EnvLike): string | undefined {
  const server = env.GITHUB_SERVER_URL?.trim().replace(/\/+$/, "");
  const repository = env.GITHUB_REPOSITORY?.trim();
  const runId = env.GITHUB_RUN_ID?.trim();
  if (!server || !repository || !runId || !DIGITS.test(runId)) return undefined;
  const base = `${server}/${repository}/actions/runs/${runId}`;
  const attempt = env.GITHUB_RUN_ATTEMPT?.trim();
  return attempt && DIGITS.test(attempt) && Number(attempt) > 1
    ? `${base}/attempts/${attempt}`
    : base;
}

const fromVar =
  (name: string) =>
  (env: EnvLike): string | undefined =>
    env[name];

const CI_PROVIDERS: readonly CiProvider[] = [
  { slug: "github-actions", detect: "GITHUB_ACTIONS", runUrl: githubRunUrl },
  { slug: "gitlab", detect: "GITLAB_CI", runUrl: fromVar("CI_JOB_URL") },
  { slug: "circleci", detect: "CIRCLECI", runUrl: fromVar("CIRCLE_BUILD_URL") },
  { slug: "buildkite", detect: "BUILDKITE", runUrl: fromVar("BUILDKITE_BUILD_URL") },
  { slug: "jenkins", detect: "JENKINS_URL", runUrl: fromVar("BUILD_URL") },
  { slug: "bitbucket", detect: "BITBUCKET_BUILD_NUMBER" },
  { slug: "azure-pipelines", detect: "TF_BUILD" },
  { slug: "vercel", detect: "VERCEL" },
  { slug: "netlify", detect: "NETLIFY" },
  { slug: "cloudflare-pages", detect: "CF_PAGES" },
];

const GENERIC_PROVIDER = "ci";

function isSet(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "false" && normalized !== "0";
}

export function sanitizeCiRunUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname === "") return null;
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  const href = url.href;
  return href.length <= MAX_RUN_URL_LENGTH ? href : null;
}

export function detectCiContext(env: EnvLike): CiContext {
  const provider = CI_PROVIDERS.find((candidate) => isSet(env[candidate.detect]));
  if (provider) {
    const context: CiContext = { environment: "ci", ciProvider: provider.slug };
    const runUrl = sanitizeCiRunUrl(provider.runUrl?.(env));
    if (runUrl !== null) context.ciRunUrl = runUrl;
    return context;
  }
  if (isSet(env.CI)) return { environment: "ci", ciProvider: GENERIC_PROVIDER };
  return { environment: "local" };
}
