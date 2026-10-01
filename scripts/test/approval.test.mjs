import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  APPROVAL_ENVIRONMENT,
  APPROVE_WORKFLOW,
  approvalDispatch,
  approvalProblems,
  approvedTarget,
  approveRunId,
  engineReleaseProblem,
  freshnessProblem,
  newestReleaseTag,
  rangeFloor,
  releaseApproval,
  requiredReviewers,
} from "../lib/approval.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPOSITORY = "afterpack-dev/afterpack";
const SHA = "a".repeat(40);

const run = (overrides = {}) => ({
  id: 36800000001,
  display_title: "Approve shipping 0.2.2-rc.202610011200",
  path: APPROVE_WORKFLOW,
  head_branch: "main",
  head_sha: SHA,
  event: "repository_dispatch",
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
    expect: { kind: "engine", version: "0.2.2" },
    ...parts,
  });

const releaseRun = (overrides = {}) =>
  run({
    display_title: `Approve releasing the CLI and plugins (patch) at ${SHA}`,
    event: "workflow_dispatch",
    ...overrides,
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

describe("approvedTarget", () => {
  it("reads what an Approve run's title approves, and nothing else", () => {
    assert.deepEqual(approvedTarget("Approve shipping 0.2.2-rc.202610011200"), {
      kind: "engine",
      rc: "0.2.2-rc.202610011200",
      stable: "0.2.2",
    });
    assert.deepEqual(approvedTarget(`Approve releasing the CLI and plugins (minor) at ${SHA}`), {
      kind: "public",
      bump: "minor",
      sha: SHA,
    });
    for (const title of [
      "Approve shipping 0.2.2",
      "Approve shipping 0.2.2-rc.202610011200 (dry run)",
      `Approve releasing the CLI and plugins (patch) at ${SHA} (dry run)`,
      "Approve releasing the CLI and plugins (patch) at abc",
      "Publish engine 0.2.2 (latest)",
      undefined,
    ]) {
      assert.equal(approvedTarget(title), null, String(title));
    }
  });

  it("matches the titles approve.yml writes", () => {
    const yml = fs.readFileSync(path.join(ROOT, ".github", "workflows", "approve.yml"), "utf8");
    assert.match(yml, /format\('Approve shipping \{0\}\{1\}'/);
    assert.match(yml, /format\('Approve releasing the CLI and plugins \(\{0\}\) at \{1\}\{2\}'/);
    assert.match(yml, /inputs\.dry_run && ' \(dry run\)'/);
  });
});

describe("approvalProblems", () => {
  it("accepts the required reviewer's approval of the main Approve run for this version", () => {
    assert.deepEqual(check(), []);
    assert.deepEqual(check({ run: run({ event: "workflow_dispatch" }) }), []);
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
      ["another stable", { expect: { kind: "engine", version: "0.2.3" } }],
      ["a stable title", { run: run({ display_title: "Approve shipping 0.2.2" }) }],
      [
        "a dry run",
        { run: run({ display_title: "Approve shipping 0.2.2-rc.202610011200 (dry run)" }) },
      ],
      ["a public release approval", { run: releaseRun() }],
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

  it("binds a public release to its bump and to the commit the run ran on", () => {
    const expect = { kind: "public", bump: "patch" };
    assert.deepEqual(check({ run: releaseRun(), expect }), []);
    assert.match(
      check({ run: releaseRun(), expect: { kind: "public", bump: "minor" } })[0],
      /minor/,
    );
    assert.match(check({ run: run(), expect })[0], /does not approve a patch release/);
    assert.match(
      check({ run: releaseRun({ head_sha: "b".repeat(40) }), expect })[0],
      /ran on b{40}/,
    );
  });
});

describe("releaseApproval", () => {
  it("takes the engine and its approval from core-published", () => {
    assert.deepEqual(
      releaseApproval({
        event: "repository_dispatch",
        payload: { version: "v0.2.2", approve_run_id: "36800000001" },
      }),
      { id: "36800000001", expect: { kind: "engine", version: "0.2.2" } },
    );
  });

  it("takes the bump and the approval of a manual release", () => {
    assert.deepEqual(
      releaseApproval({ event: "workflow_dispatch", inputBump: "minor", inputApproveRunId: "9" }),
      { id: "9", expect: { kind: "public", bump: "minor" } },
    );
  });

  it("refuses a release that names no approval", () => {
    assert.throws(
      () => releaseApproval({ event: "repository_dispatch", payload: { version: "v0.2.2" } }),
      /approve_run_id '' is not a workflow run id/,
    );
    assert.throws(
      () => releaseApproval({ event: "workflow_dispatch", inputBump: "patch" }),
      /approve_run_id/,
    );
    assert.throws(
      () => releaseApproval({ event: "repository_dispatch", payload: { version: "0.2.2-rc.1" } }),
      /not a stable engine version/,
    );
  });
});

describe("newestReleaseTag", () => {
  it("picks the highest vX.Y.Z tag, numerically", () => {
    const refs = ["v0.2.0", "v0.10.0", "v0.9.9", "v1.0.0-rc.1", "other"].map((tag, i) => ({
      ref: `refs/tags/${tag}`,
      object: { sha: String(i) },
    }));
    assert.deepEqual(newestReleaseTag(refs), { tag: "v0.10.0", sha: "1" });
    assert.equal(newestReleaseTag([]), null);
  });
});

describe("freshnessProblem", () => {
  const newest = { tag: "v0.2.0", sha: "b".repeat(40) };

  it("releases only a commit ahead of the newest vX.Y.Z tag", () => {
    assert.equal(freshnessProblem({ sha: SHA, newest, status: "ahead" }), null);
    assert.equal(freshnessProblem({ sha: SHA, newest: null, status: undefined }), null);
  });

  it("refuses a commit the newest tag already holds, an older one and one off main", () => {
    for (const status of ["identical", "behind", "diverged", undefined]) {
      assert.equal(
        freshnessProblem({ sha: SHA, newest, status }),
        `the approved commit ${SHA} is ${status ?? "unknown"} against v0.2.0, so it is already released or not on main: approve a newer commit`,
        String(status),
      );
    }
  });
});

describe("engineReleaseProblem", () => {
  const cli = (range) => ({ version: "0.2.0", dependencies: { "@afterpack/core": range } });

  it("lets an engine approval release the CLI while afterpack@latest is on an older engine", () => {
    assert.equal(engineReleaseProblem(cli("~0.2.0"), "0.2.1"), null);
    assert.equal(engineReleaseProblem(cli("~0.2.1"), "0.3.0"), null);
    assert.equal(engineReleaseProblem(null, "0.2.1"), null, "nothing released yet");
  });

  it("refuses a replay once a release repinned the CLI to that engine or a later one", () => {
    assert.match(
      engineReleaseProblem(cli("~0.2.1"), "0.2.1"),
      /^afterpack@0\.2\.0 already pins @afterpack\/core ~0\.2\.1, so a release already repinned the engine to 0\.2\.1 or later\. An engine approval releases the CLI and plugins once/,
    );
    assert.match(engineReleaseProblem(cli("~0.2.1"), "0.2.0"), /already pins/);
  });

  it("refuses a pin it cannot compare", () => {
    assert.match(engineReleaseProblem(cli("workspace:*"), "0.2.1"), /names no version/);
    assert.match(engineReleaseProblem({ version: "0.2.0" }, "0.2.1"), /'\(nothing\)'/);
  });

  it("reads the floor of a pinned range", () => {
    assert.equal(rangeFloor("~0.2.0"), "0.2.0");
    assert.equal(rangeFloor("^1.2.3"), "1.2.3");
    assert.equal(rangeFloor(">=0.2.1"), "0.2.1");
    assert.equal(rangeFloor("0.2.1"), "0.2.1");
    assert.equal(rangeFloor("~0.2.0 || ~0.3.0"), null);
    assert.equal(rangeFloor(undefined), null);
  });
});

describe("approvalDispatch", () => {
  const engine = {
    kind: "engine",
    version: "0.2.2-rc.202610011200",
    runId: "36800000001",
    repository: REPOSITORY,
    shipRepo: "owner/engine",
    shipToken: "token",
  };

  it("starts the ship with the RC and this run's id", () => {
    const dispatch = approvalDispatch(engine);
    assert.equal(
      dispatch.workflow,
      "https://api.github.com/repos/owner/engine/actions/workflows/ship.yml",
    );
    assert.equal(dispatch.token, "token");
    assert.deepEqual(dispatch.body, {
      ref: "main",
      inputs: { rc_version: "0.2.2-rc.202610011200", approve_run_id: "36800000001" },
    });
    assert.doesNotMatch(dispatch.target, /owner\/engine/);
  });

  it("starts a public release with the bump and this run's id", () => {
    const dispatch = approvalDispatch({
      kind: "public",
      bump: "minor",
      runId: "5",
      repository: REPOSITORY,
      githubToken: "g",
    });
    assert.equal(
      dispatch.workflow,
      `https://api.github.com/repos/${REPOSITORY}/actions/workflows/release.yml`,
    );
    assert.deepEqual(dispatch.body, {
      ref: "main",
      inputs: { bump: "minor", approve_run_id: "5" },
    });
  });

  it("fails loudly on a missing secret, a malformed RC and an unknown kind", () => {
    assert.throws(
      () => approvalDispatch({ ...engine, shipToken: "" }),
      /no SHIP_DISPATCH_TOKEN secret/,
    );
    assert.throws(
      () => approvalDispatch({ ...engine, shipToken: undefined }),
      /no SHIP_DISPATCH_TOKEN/,
    );
    assert.throws(() => approvalDispatch({ ...engine, shipRepo: "" }), /SHIP_DISPATCH_REPO secret/);
    assert.throws(
      () => approvalDispatch({ ...engine, version: "0.2.2" }),
      /not an engine release candidate/,
    );
    assert.throws(() => approvalDispatch({ ...engine, runId: "" }), /approve_run_id/);
    assert.throws(
      () => approvalDispatch({ ...engine, kind: "" }),
      /kind '' is not engine or public/,
    );
    assert.throws(
      () => approvalDispatch({ kind: "public", bump: "huge", runId: "5" }),
      /bump 'huge'/,
    );
    assert.throws(
      () => approvalDispatch({ kind: "public", bump: "patch", runId: "5" }),
      /GH_TOKEN/,
    );
  });

  it("fails the Approve job before it dispatches anything when a secret is empty", () => {
    const result = spawnSync(process.execPath, [path.join(ROOT, "scripts", "approve.mjs")], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        KIND: "engine",
        VERSION: "0.2.2-rc.202610011200",
        GITHUB_RUN_ID: "36800000001",
        GITHUB_REPOSITORY: REPOSITORY,
        SHIP_DISPATCH_TOKEN: "",
        SHIP_DISPATCH_REPO: "owner/engine",
        GITHUB_API_URL: "http://127.0.0.1:9",
      },
    });
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /::error::the ship-approval environment has no SHIP_DISPATCH_TOKEN secret/,
    );
  });
});
