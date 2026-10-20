import { CORE, servedEngineCheck } from "./lib/engine.mjs";
import { appendFile } from "./lib/registry.mjs";

const engine = (process.env.ENGINE ?? "").trim() || "candidate";
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

const { problems, engineVersion } = servedEngineCheck(info, { engine, version, sha });
if (problems.length > 0) {
  for (const problem of problems) console.error(`::error::${problem}`);
  if (engine === "candidate") {
    console.error(
      `${CORE}@${version} cannot be tested on the Pro engine until the API serves the engine built from ${sha}`,
    );
  }
  process.exit(1);
}

const builtFrom = info.engineSourceSha;
appendFile("GITHUB_OUTPUT", `version=${version}\nengine_version=${engineVersion}\n`);
if (engine === "candidate") {
  console.log(`the API serves engine ${info.engineVersion} built from ${builtFrom}`);
  appendFile(
    "GITHUB_STEP_SUMMARY",
    `The API serves the Pro engine \`${info.engineVersion}\` built from \`${builtFrom}\`, the source of \`${CORE}@${version}\`.\n\n`,
  );
} else {
  console.log(
    `testing ${CORE}@${version} as the client of the served engine ${info.engineVersion} built from ${builtFrom}`,
  );
  appendFile(
    "GITHUB_STEP_SUMMARY",
    `\`${CORE}@${version}\` is the client of the Pro engine the API serves now: \`${info.engineVersion}\` built from \`${builtFrom}\`, not the candidate's own Pro engine.\n\n`,
  );
}
