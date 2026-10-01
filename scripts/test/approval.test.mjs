import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  APPROVAL_ENVIRONMENT,
  APPROVE_WORKFLOW,
  approvalProblems,
  approveRunId,
  requiredReviewers,
} from "../lib/approval.mjs";

const REPOSITORY = "afterpack-dev/afterpack";

const run = (overrides = {}) => ({
  id: 36800000001,
  display_title: "Approve shipping 0.2.2-rc.202610011200",
  path: APPROVE_WORKFLOW,
  head_branch: "main",
  event: "workflow_dispatch",
  status: "completed",
  conclusion: "success",
  html_url: `https://github.com/${REPOSITORY}/actions/runs/36800000001`,
  repository: { full_name: REPOSITORY },
  ...overrides,
});

const environment = (reviewers = [{ type: "User", reviewer: { login: "operator" } }]) => ({
  name: APPROVAL_ENVIRONMENT,
  protection_rules: [
    { type: "required_reviewers", prevent_self_review: false, reviewers },
    { type: "branch_policy" },
  ],
  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
});

const approvals = (overrides = {}) => [
  {
    state: "approved",
    comment: "",
    user: { login: "Operator" },
    environments: [{ name: APPROVAL_ENVIRONMENT }],
    ...overrides,
  },
];

const check = (parts = {}) =>
  approvalProblems({
    run: run(),
    approvals: approvals(),
    environment: environment(),
    repository: REPOSITORY,
    version: "0.2.2",
    ...parts,
  });

describe("approveRunId", () => {
  it("reads a run id from a string or a number", () => {
    assert.equal(approveRunId("36800000001"), "36800000001");
    assert.equal(approveRunId(36800000001), "36800000001");
  });

  it("refuses a missing or malformed id", () => {
    for (const value of [undefined, null, "", " ", "0x1", "12 ", "-3", "latest"]) {
      assert.throws(() => approveRunId(value), /approve_run_id/, String(value));
    }
  });
});

describe("requiredReviewers", () => {
  it("lists the required reviewers who are users, in lower case", () => {
    assert.deepEqual(requiredReviewers(environment()), ["operator"]);
    assert.deepEqual(
      requiredReviewers(environment([{ type: "Team", reviewer: { slug: "core" } }])),
      [],
    );
    assert.deepEqual(requiredReviewers(null), []);
  });
});

describe("approvalProblems", () => {
  it("accepts the required reviewer's approval of the main Approve run for this version", () => {
    assert.deepEqual(check(), []);
  });

  it("refuses each forgery on its own", () => {
    const cases = [
      ["no such run", { run: null }],
      ["another repository", { run: run({ repository: { full_name: "someone/afterpack" } }) }],
      ["another workflow", { run: run({ path: ".github/workflows/ci.yml" }) }],
      ["a branch", { run: run({ head_branch: "ship-it" }) }],
      ["a push", { run: run({ event: "push" }) }],
      ["a run still waiting", { run: run({ status: "waiting", conclusion: null }) }],
      ["a rejected run", { run: run({ conclusion: "failure" }) }],
      ["another stable", { version: "0.2.3" }],
      ["a stable title", { run: run({ display_title: "Approve shipping 0.2.2" }) }],
      [
        "a decorated title",
        { run: run({ display_title: "Approve shipping 0.2.2-rc.202610011200 (dry run)" }) },
      ],
      ["no approval", { approvals: [] }],
      ["a rejection", { approvals: approvals({ state: "rejected" }) }],
      ["another reviewer", { approvals: approvals({ user: { login: "helper-bot" } }) }],
      ["another environment", { approvals: approvals({ environments: [{ name: "npm" }] }) }],
      ["an environment with no reviewer", { environment: environment([]) }],
      ["no environment", { environment: null }],
    ];
    for (const [what, parts] of cases) {
      assert.equal(check(parts).length, 1, `${what}: ${check(parts).join("; ")}`);
    }
  });
});
