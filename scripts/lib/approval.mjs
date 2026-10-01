import { compareVersions } from "./bump.mjs";

export const APPROVE_WORKFLOW = ".github/workflows/approve.yml";

export const APPROVAL_ENVIRONMENT = "ship-approval";

export const APPROVE_EVENTS = ["workflow_dispatch", "repository_dispatch"];

export const BUMPS = ["patch", "minor", "major"];

const ENGINE_RC = /^(\d+\.\d+\.\d+)-rc\.\d+$/;

const ENGINE_TITLE = /^Approve shipping (\d+\.\d+\.\d+-rc\.\d+)$/;

const PUBLIC_TITLE =
  /^Approve releasing the CLI and plugins \((patch|minor|major)\) at ([0-9a-f]{40})$/;

export function approveRunId(value) {
  const id = String(value ?? "");
  if (!/^\d+$/.test(id)) throw new Error(`approve_run_id '${id}' is not a workflow run id`);
  return id;
}

export function approvedTarget(title) {
  const engine = ENGINE_TITLE.exec(title ?? "");
  if (engine) return { kind: "engine", rc: engine[1], stable: ENGINE_RC.exec(engine[1])[1] };
  const release = PUBLIC_TITLE.exec(title ?? "");
  if (release) return { kind: "public", bump: release[1], sha: release[2] };
  return null;
}

export function requiredReviewers(environment) {
  return (environment?.protection_rules ?? [])
    .filter((rule) => rule?.type === "required_reviewers")
    .flatMap((rule) => rule.reviewers ?? [])
    .filter((entry) => entry?.type === "User" && entry.reviewer?.login)
    .map((entry) => entry.reviewer.login.toLowerCase());
}

function targetProblem(run, expect) {
  const target = approvedTarget(run.display_title);
  if (expect.kind === "engine") {
    if (target?.kind === "engine" && target.stable === expect.version) return null;
    return `it is titled "${run.display_title}", which does not approve a ${expect.version} RC`;
  }
  if (target?.kind !== "public" || target.bump !== expect.bump) {
    return `it is titled "${run.display_title}", which does not approve a ${expect.bump} release of the CLI and plugins`;
  }
  if (target.sha !== run.head_sha) {
    return `its title names ${target.sha}, but it ran on ${run.head_sha}`;
  }
  return null;
}

export function approvalProblems({ run, approvals, environment, repository, expect }) {
  if (!run) return [`there is no such run in ${repository}`];
  const problems = [];
  if (run.repository?.full_name !== repository) {
    problems.push(`it belongs to ${run.repository?.full_name}, not ${repository}`);
  }
  if (run.path !== APPROVE_WORKFLOW) problems.push(`it is ${run.path}, not ${APPROVE_WORKFLOW}`);
  if (run.head_branch !== "main") problems.push(`it ran on ${run.head_branch}, not main`);
  if (!APPROVE_EVENTS.includes(run.event)) {
    problems.push(`it was a ${run.event}, not a dispatch`);
  }
  if (run.status !== "completed" || run.conclusion !== "success") {
    problems.push(
      `it is ${run.status === "completed" ? run.conclusion : run.status}, not a success`,
    );
  }
  const target = targetProblem(run, expect);
  if (target) problems.push(target);
  const reviewers = requiredReviewers(environment);
  if (reviewers.length === 0) {
    problems.push(`the ${APPROVAL_ENVIRONMENT} environment has no required reviewer`);
  } else {
    const approved = (approvals ?? []).some(
      (a) =>
        a?.state === "approved" &&
        reviewers.includes(a.user?.login?.toLowerCase()) &&
        (a.environments ?? []).some((e) => e?.name === APPROVAL_ENVIRONMENT),
    );
    if (!approved) {
      problems.push(
        `no required reviewer (${reviewers.join(", ")}) approved ${APPROVAL_ENVIRONMENT}`,
      );
    }
  }
  return problems;
}

export function releaseApproval({ event, payload, inputBump, inputApproveRunId }) {
  if (event === "repository_dispatch") {
    const version = String(payload?.version ?? "").replace(/^v/, "");
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      throw new Error(`core-published names '${version}', not a stable engine version`);
    }
    return { id: approveRunId(payload?.approve_run_id), expect: { kind: "engine", version } };
  }
  if (!BUMPS.includes(inputBump)) throw new Error(`bump '${inputBump}' is not ${BUMPS.join(", ")}`);
  return { id: approveRunId(inputApproveRunId), expect: { kind: "public", bump: inputBump } };
}

export function approvalDispatch(request) {
  const { kind, version, bump, runId, repository, shipRepo, shipToken, githubToken } = request;
  const api = request.api ?? "https://api.github.com";
  const id = approveRunId(runId);
  if (kind === "engine") {
    if (!ENGINE_RC.test(version ?? "")) {
      throw new Error(`'${version ?? ""}' is not an engine release candidate (X.Y.Z-rc.<digits>)`);
    }
    if (!shipToken) {
      throw new Error(
        `the ${APPROVAL_ENVIRONMENT} environment has no SHIP_DISPATCH_TOKEN secret, so the approved ship cannot start`,
      );
    }
    if (!/^[\w.-]+\/[\w.-]+$/.test(shipRepo ?? "")) {
      throw new Error(
        `the ${APPROVAL_ENVIRONMENT} environment's SHIP_DISPATCH_REPO secret is not an owner/name`,
      );
    }
    return {
      what: `shipping ${version}`,
      target: "ship.yml in the repository SHIP_DISPATCH_REPO names",
      token: shipToken,
      workflow: `${api}/repos/${shipRepo}/actions/workflows/ship.yml`,
      body: { ref: "main", inputs: { rc_version: version, approve_run_id: id } },
    };
  }
  if (kind === "public") {
    if (!BUMPS.includes(bump)) throw new Error(`bump '${bump ?? ""}' is not ${BUMPS.join(", ")}`);
    if (!githubToken) throw new Error("GH_TOKEN is not set, so release.yml cannot be dispatched");
    return {
      what: `a ${bump} release of the CLI and plugins`,
      target: `release.yml in ${repository}`,
      token: githubToken,
      workflow: `${api}/repos/${repository}/actions/workflows/release.yml`,
      body: { ref: "main", inputs: { bump, approve_run_id: id } },
    };
  }
  throw new Error(`kind '${kind ?? ""}' is not engine or public`);
}

export function freshnessProblem({ sha, newest, status }) {
  if (!newest || status === "ahead") return null;
  return `the approved commit ${sha} is ${status ?? "unknown"} against ${newest.tag}, so it is already released or not on main: approve a newer commit`;
}

export function newestReleaseTag(refs) {
  const tags = (refs ?? [])
    .map((ref) => ({
      tag: String(ref?.ref ?? "").replace(/^refs\/tags\//, ""),
      sha: ref?.object?.sha,
    }))
    .filter(({ tag, sha }) => /^v\d+\.\d+\.\d+$/.test(tag) && sha);
  return tags.sort((a, b) => compareVersions(b.tag.slice(1), a.tag.slice(1)))[0] ?? null;
}
