import { approvalDispatch } from "./lib/approval.mjs";
import { appendFile, request } from "./lib/registry.mjs";

const env = process.env;

const headers = (token) => ({
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  authorization: `Bearer ${token}`,
});

async function main() {
  const dispatch = approvalDispatch({
    kind: env.KIND,
    version: env.VERSION,
    bump: env.BUMP,
    runId: env.GITHUB_RUN_ID,
    repository: env.GITHUB_REPOSITORY,
    shipRepo: env.SHIP_DISPATCH_REPO,
    shipToken: env.SHIP_DISPATCH_TOKEN,
    githubToken: env.GH_TOKEN,
    api: env.GITHUB_API_URL,
  });
  const dryRun = env.DRY_RUN === "true";
  appendFile(
    "GITHUB_STEP_SUMMARY",
    `${dryRun ? "Dry run: approved" : "Approved"} ${dispatch.what} (requested by ${env.REQUESTED_BY}).\n\n${env.SUMMARY ?? ""}\n\n`,
  );
  if (dryRun) {
    const response = await request(dispatch.workflow, { headers: headers(dispatch.token) });
    await response.body?.cancel();
    if (!response.ok) {
      throw new Error(`the token cannot read ${dispatch.target}: ${response.status}`);
    }
    console.log(`dry run: the token reads ${dispatch.target}; nothing was dispatched`);
    return;
  }
  const response = await request(`${dispatch.workflow}/dispatches`, {
    method: "POST",
    headers: { ...headers(dispatch.token), "content-type": "application/json" },
    body: JSON.stringify(dispatch.body),
  });
  if (!response.ok) {
    throw new Error(
      `dispatching ${dispatch.target} answered ${response.status}: ${(await response.text()).slice(0, 200)}`,
    );
  }
  await response.body?.cancel();
  console.log(`dispatched ${dispatch.target} for ${dispatch.what}`);
  appendFile("GITHUB_STEP_SUMMARY", `Started ${dispatch.target}.\n`);
}

try {
  await main();
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exitCode = 1;
}
