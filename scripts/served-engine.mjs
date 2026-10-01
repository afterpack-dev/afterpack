import { CORE, releaseOf, servedEngineProblems } from "./lib/engine.mjs";
import { appendFile } from "./lib/registry.mjs";

const version = (process.env.VERSION ?? "").replace(/^v/, "");
const sha = (process.env.SHA ?? "").trim().toLowerCase();
const api = (process.env.AFTERPACK_API_URL ?? "").replace(/\/+$/, "");

if (!api) {
  console.error("::error::AFTERPACK_API_URL must be set in this job's environment");
  process.exit(1);
}

let info = null;
try {
  const response = await fetch(`${api}/v1/version`, { signal: AbortSignal.timeout(30_000) });
  if (response.ok) info = await response.json();
  else console.error(`GET /v1/version answered ${response.status}`);
} catch (error) {
  console.error(`GET /v1/version failed: ${error.message}`);
}

const problems = servedEngineProblems(info, { version, sha });
if (problems.length > 0) {
  for (const problem of problems) console.error(`::error::${problem}`);
  console.error(
    `${CORE}@${version} cannot be tested on the Pro engine until the API serves the engine built from ${sha}`,
  );
  process.exit(1);
}

console.log(`the API serves engine ${info.engineVersion} built from ${sha}`);
appendFile("GITHUB_OUTPUT", `version=${version}\nengine_version=${releaseOf(version)}\n`);
appendFile(
  "GITHUB_STEP_SUMMARY",
  `The API serves the Pro engine \`${info.engineVersion}\` built from \`${sha}\`, the source of \`${CORE}@${version}\`.\n\n`,
);
