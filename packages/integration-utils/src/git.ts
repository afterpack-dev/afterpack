import { execFileSync } from "node:child_process";
import type { EnvLike } from "./policy.js";

export const GIT_COMMIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/;

export const GIT_REF_PATTERN = /^[A-Za-z0-9._\-/+]{1,200}$/;

export interface GitBuildContext {
  commitSha?: string;
  ref?: string;
}

export interface DetectGitDeps {
  env?: EnvLike;
  cwd?: string;
  localGit?: (cwd?: string) => GitBuildContext | null;
}

export function sanitizeCommitSha(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const sha = value.trim().toLowerCase();
  return GIT_COMMIT_SHA_PATTERN.test(sha) ? sha : null;
}

export function sanitizeGitRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ref = value.trim();
  return GIT_REF_PATTERN.test(ref) ? ref : null;
}

function contextFrom(rawSha: unknown, rawRef: unknown): GitBuildContext | null {
  const commitSha = sanitizeCommitSha(rawSha);
  const ref = sanitizeGitRef(rawRef);
  if (commitSha === null && ref === null) return null;
  const context: GitBuildContext = {};
  if (commitSha !== null) context.commitSha = commitSha;
  if (ref !== null) context.ref = ref;
  return context;
}

const CI_SOURCES: readonly (readonly [string, string])[] = [
  ["GITHUB_SHA", "GITHUB_REF_NAME"],
  ["CI_COMMIT_SHA", "CI_COMMIT_REF_NAME"],
  ["VERCEL_GIT_COMMIT_SHA", "VERCEL_GIT_COMMIT_REF"],
  ["CF_PAGES_COMMIT_SHA", "CF_PAGES_BRANCH"],
  ["GIT_COMMIT", "BRANCH_NAME"],
];

export function ciGitContext(env: EnvLike): GitBuildContext | null {
  for (const [shaVar, refVar] of CI_SOURCES) {
    const context = contextFrom(env[shaVar], env[refVar]);
    if (context !== null) return context;
  }
  return null;
}

const GIT_PROBE_TIMEOUT_MS = 2000;

export function localGitContext(cwd?: string): GitBuildContext | null {
  let lines: string[];
  try {
    const out = execFileSync("git", ["rev-parse", "HEAD", "--abbrev-ref", "HEAD"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_PROBE_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
    }).toString();
    lines = out.split("\n").map((line) => line.trim());
  } catch {
    return null;
  }
  const ref = lines[1] === "HEAD" ? null : lines[1];
  return contextFrom(lines[0], ref);
}

export function detectGitContext(
  explicit?: GitBuildContext | null,
  deps: DetectGitDeps = {},
): GitBuildContext | null {
  if (explicit) {
    const declared = contextFrom(explicit.commitSha, explicit.ref);
    if (declared !== null) return declared;
  }
  const ci = ciGitContext(deps.env ?? (process.env as EnvLike));
  if (ci !== null) return ci;
  return (deps.localGit ?? localGitContext)(deps.cwd);
}
