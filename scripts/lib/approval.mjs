export const APPROVE_WORKFLOW = ".github/workflows/approve.yml";

export const APPROVAL_ENVIRONMENT = "ship-approval";

const APPROVE_TITLE = /^Approve shipping (\d+\.\d+\.\d+)-rc\.\d+$/;

export function approveRunId(value) {
  const id = String(value ?? "");
  if (!/^\d+$/.test(id)) throw new Error(`approve_run_id '${id}' is not a workflow run id`);
  return id;
}

export function requiredReviewers(environment) {
  return (environment?.protection_rules ?? [])
    .filter((rule) => rule?.type === "required_reviewers")
    .flatMap((rule) => rule.reviewers ?? [])
    .filter((entry) => entry?.type === "User" && entry.reviewer?.login)
    .map((entry) => entry.reviewer.login.toLowerCase());
}

export function approvalProblems({ run, approvals, environment, repository, version }) {
  if (!run) return [`there is no such run in ${repository}`];
  const problems = [];
  if (run.repository?.full_name !== repository) {
    problems.push(`it belongs to ${run.repository?.full_name}, not ${repository}`);
  }
  if (run.path !== APPROVE_WORKFLOW) problems.push(`it is ${run.path}, not ${APPROVE_WORKFLOW}`);
  if (run.head_branch !== "main") problems.push(`it ran on ${run.head_branch}, not main`);
  if (run.event !== "workflow_dispatch") problems.push(`it was a ${run.event}, not a dispatch`);
  if (run.status !== "completed" || run.conclusion !== "success") {
    problems.push(
      `it is ${run.status === "completed" ? run.conclusion : run.status}, not a success`,
    );
  }
  const title = APPROVE_TITLE.exec(run.display_title ?? "");
  if (title?.[1] !== version) {
    problems.push(`it is titled "${run.display_title}", which does not approve a ${version} RC`);
  }
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
