import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  APPROVAL_ENVIRONMENT,
  approvalProblems,
  approvedTarget,
  approveRunId,
  freshnessProblem,
  newestReleaseTag,
  releaseApproval,
} from "./lib/approval.mjs";
import {
  approvedRcOf,
  checkEnginePackage,
  ENGINE_PACKAGES,
  payloadIntegrity,
  resolveEngineRelease,
} from "./lib/engine.mjs";
import {
  alreadyPublished,
  appendFile,
  describeTarball,
  npm,
  npmrcFor,
  packFilename,
  publishedDifferences,
  publishOrder,
  registryHost,
  request,
  sleep,
  versionState,
  waitUntilServed,
} from "./lib/registry.mjs";

const RECORD = "published.json";

function fail(message) {
  throw new Error(message);
}

function flag(args, name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function tarballsIn(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".tgz"));
  if (files.length === 0) fail(`no tarballs in ${dir}`);
  const tarballs = files.map((f) => describeTarball(path.join(dir, f)));
  const names = tarballs.map((t) => t.name);
  const duplicate = names.find((name, i) => names.indexOf(name) !== i);
  if (duplicate) fail(`${dir} holds more than one tarball of ${duplicate}`);
  return tarballs;
}

async function githubGet(repository, route, token = process.env.GH_TOKEN) {
  const api = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const response = await request(`${api}/repos/${repository}${route}`, {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (token && (response.status === 401 || response.status === 403)) {
    return githubGet(repository, route, "");
  }
  if (response.status === 404) return null;
  if (!response.ok) fail(`GET ${route} answered ${response.status}`);
  return response.json();
}

async function finishedRun(repository, id) {
  for (let polls = 0; ; polls++) {
    const run = await githubGet(repository, `/actions/runs/${id}`);
    if (!run || run.status === "completed" || polls >= 60) return run;
    if (polls === 0) console.log(`waiting for Approve run ${id} to finish (${run.status})`);
    await sleep(10_000);
  }
}

async function checkedApproval(id, expect) {
  const repository = process.env.GITHUB_REPOSITORY ?? fail("GITHUB_REPOSITORY is not set");
  const run = await finishedRun(repository, id);
  const approvals = run ? await githubGet(repository, `/actions/runs/${id}/approvals`) : null;
  const environment = await githubGet(repository, `/environments/${APPROVAL_ENVIRONMENT}`);
  const problems = approvalProblems({ run, approvals, environment, repository, expect });
  const what = expect.kind === "engine" ? `engine ${expect.version}` : `a ${expect.bump} release`;
  if (problems.length > 0)
    fail(`Approve run ${id} does not approve ${what}: ${problems.join("; ")}`);
  const line = `${what} was approved in ${run.html_url} ("${run.display_title}").`;
  appendFile("GITHUB_STEP_SUMMARY", `${line}\n\n`);
  console.log(line);
  return run;
}

async function verifyApproval() {
  const env = process.env;
  const payload = env.PAYLOAD ? JSON.parse(env.PAYLOAD) : null;
  const { version, fromDispatch } = resolveEngineRelease({
    event: env.EVENT,
    payload,
    inputVersion: env.INPUT_VERSION,
  });
  const id = approveRunId(fromDispatch ? payload?.approve_run_id : env.INPUT_APPROVE_RUN_ID);
  const run = await checkedApproval(id, { kind: "engine", version });
  appendFile(
    "GITHUB_ENV",
    `APPROVED_RC=${approvedTarget(run.display_title).rc}\nAPPROVE_RUN_ID=${id}\n`,
  );
}

async function verifyReleaseApproval() {
  const env = process.env;
  const { id, expect } = releaseApproval({
    event: env.EVENT,
    payload: env.PAYLOAD ? JSON.parse(env.PAYLOAD) : null,
    inputBump: env.INPUT_BUMP,
    inputApproveRunId: env.INPUT_APPROVE_RUN_ID,
  });
  const run = await checkedApproval(id, expect);
  if (expect.kind !== "public") return;
  const { sha } = approvedTarget(run.display_title);
  const repository = env.GITHUB_REPOSITORY;
  const newest = newestReleaseTag((await githubGet(repository, "/git/matching-refs/tags/v")) ?? []);
  const diff = newest ? await githubGet(repository, `/compare/${newest.sha}...${sha}`) : null;
  const problem = freshnessProblem({ sha, newest, status: diff?.status });
  if (problem) fail(problem);
  appendFile("GITHUB_OUTPUT", `sha=${sha}\n`);
  console.log(`releasing the approved commit ${sha}`);
}

function fetchEngine(args) {
  const out = flag(args, "out") ?? fail("fetch-engine needs --out <dir>");
  const env = process.env;
  const payload = env.PAYLOAD ? JSON.parse(env.PAYLOAD) : null;
  const { version, fromDispatch } = resolveEngineRelease({
    event: env.EVENT,
    payload,
    inputVersion: env.INPUT_VERSION,
  });
  const rc = approvedRcOf(env.APPROVED_RC, version);
  if (!env.ENGINE_REGISTRY || !env.ENGINE_REGISTRY_TOKEN) {
    fail("ENGINE_REGISTRY and ENGINE_REGISTRY_TOKEN must be set in the npm environment");
  }
  const host = registryHost(env.ENGINE_REGISTRY);
  if (env.GITHUB_ACTIONS === "true") console.log(`::add-mask::${host}`);
  const source = `https://${host}/`;
  const scratch = fs.mkdtempSync(path.join(env.RUNNER_TEMP ?? os.tmpdir(), "engine-source-"));
  const npmrc = path.join(scratch, "npmrc");
  fs.writeFileSync(npmrc, npmrcFor({ host, token: env.ENGINE_REGISTRY_TOKEN }), { mode: 0o600 });
  const npmEnv = { env: { ...env, NPM_CONFIG_USERCONFIG: npmrc } };
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  console.log(
    fromDispatch
      ? "Verifying against the integrity in the release dispatch."
      : "::notice::Manual retry: verifying against the integrity the source registry reports, not a release dispatch.",
  );
  try {
    const packInto = (into) => (spec) => {
      const pack = npm(
        ["pack", spec, "--registry", source, "--pack-destination", into, "--json"],
        npmEnv,
      );
      if (pack.status !== 0) fail(`npm pack ${spec} failed:\n${pack.stderr}`);
      return path.join(into, packFilename(pack.stdout));
    };
    for (const name of ENGINE_PACKAGES) {
      const spec = `${name}@${version}`;
      let want = fromDispatch ? payloadIntegrity(payload, name) : null;
      if (!fromDispatch) {
        const view = npm(["view", spec, "dist.integrity", "--registry", source], npmEnv);
        if (view.status !== 0) fail(`npm view ${spec} failed:\n${view.stderr}`);
        want = view.stdout.trim() || null;
      }
      const { tarball, approved } = checkEnginePackage({
        name,
        version,
        rc,
        want,
        packStable: packInto(out),
        packApproved: packInto(scratch),
      });
      console.log(`verified ${spec} ${tarball.integrity}: the approved ${approved}, restamped`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  appendFile("GITHUB_ENV", `VERSION=${version}\n`);
  console.log(`engine ${version}, the approved ${rc}, is ready to publish from ${out}`);
}

async function publish(args) {
  const dir = flag(args, "dir") ?? fail("publish needs --dir <dir>");
  const tag = flag(args, "tag") ?? fail("publish needs --tag <dist-tag>");
  const provenance = args.includes("--provenance");
  const dryRun = args.includes("--dry-run");
  const tarballs = tarballsIn(dir);
  const byName = new Map(tarballs.map((t) => [t.name, t]));
  const plan = [];
  const conflicts = [];
  for (const { name } of publishOrder(tarballs.map((t) => t.manifest))) {
    const tarball = byName.get(name);
    const spec = `${name}@${tarball.version}`;
    const live = await versionState(name, tarball.version);
    if (live.published) {
      const differences = await publishedDifferences(tarball, live);
      if (differences.length > 0) {
        const shown = differences.slice(0, 5).join(", ");
        const more = differences.length > 5 ? ` and ${differences.length - 5} more` : "";
        conflicts.push(`${spec} (${shown}${more})`);
      } else if (live.integrity !== tarball.integrity) {
        console.log(`::notice::${spec} is on npmjs with the same files in other tarball bytes`);
      }
    }
    plan.push({ name, spec, tarball, live });
  }
  if (conflicts.length > 0) {
    fail(
      `npmjs already holds a different build of ${conflicts.join("; ")}. Resume a release with Re-run failed jobs on the run that published it, or release a new version.`,
    );
  }
  const record = [];
  for (const { name, spec, tarball, live } of plan) {
    if (live.published) {
      console.log(`skip: ${spec} already on npmjs`);
      record.push({
        name,
        version: tarball.version,
        integrity: live.integrity,
        outcome: "skipped",
      });
      continue;
    }
    const publishArgs = ["publish", tarball.file, "--access", "public", "--tag", tag];
    publishArgs.push(provenance ? "--provenance" : "--provenance=false");
    if (dryRun) publishArgs.push("--dry-run");
    const result = npm(publishArgs, {
      env: provenance ? process.env : { ...process.env, NPM_CONFIG_PROVENANCE: "false" },
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    let outcome = dryRun ? "dry run" : "published";
    if (result.status !== 0) {
      if (!alreadyPublished(`${result.stdout}\n${result.stderr}`)) {
        fail(`npm publish ${spec} failed with exit code ${result.status}`);
      }
      console.log(`::notice::${spec} was already published; npmjs is still processing it`);
      outcome = "processing";
    }
    record.push({ name, version: tarball.version, integrity: tarball.integrity, outcome });
  }
  fs.writeFileSync(path.join(dir, RECORD), `${JSON.stringify(record, null, 2)}\n`);
  const rows = record.map((r) => `| \`${r.name}@${r.version}\` | ${r.outcome} |`);
  appendFile(
    "GITHUB_STEP_SUMMARY",
    `| Package | Outcome (dist-tag \`${tag}\`) |\n| --- | --- |\n${rows.join("\n")}\n\n`,
  );
  console.log(`${record.length} package(s): ${record.map((r) => r.outcome).join(", ")}`);
}

async function wait(args) {
  const dir = flag(args, "dir");
  const tag = flag(args, "tag");
  const minutes = Number(flag(args, "deadline-minutes") ?? 45);
  let entries;
  if (dir) {
    entries = JSON.parse(fs.readFileSync(path.join(dir, RECORD), "utf8")).map((r) => ({
      ...r,
      tag: r.outcome === "skipped" ? undefined : tag,
    }));
  } else {
    const version = flag(args, "version") ?? fail("wait needs --dir or --version");
    const names = flag(args, "packages")?.split(",") ?? ENGINE_PACKAGES;
    entries = names.map((name) => ({ name, version, integrity: null, tag }));
  }
  if (entries.length === 0) fail("nothing to wait for");
  console.log(`waiting up to ${minutes} min for npmjs to serve ${entries.length} package(s)`);
  await waitUntilServed(entries, { deadlineMs: minutes * 60 * 1000 });
  console.log(`npmjs serves every tarball of ${entries[0].version}`);
}

const COMMANDS = {
  "verify-approval": verifyApproval,
  "verify-release-approval": verifyReleaseApproval,
  "fetch-engine": fetchEngine,
  publish,
  wait,
};
const [command, ...args] = process.argv.slice(2);
try {
  if (!COMMANDS[command]) {
    fail(
      "usage: node scripts/npm-release.mjs verify-approval | verify-release-approval | fetch-engine --out <dir> | publish --dir <dir> --tag <tag> [--provenance] [--dry-run] | wait (--dir <dir> | --version <v> [--packages a,b]) [--tag <tag>] [--deadline-minutes 45]",
    );
  }
  await COMMANDS[command](args);
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exitCode = 1;
}
