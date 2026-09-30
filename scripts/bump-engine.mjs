import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyEngineBump, planEngineBump, readRepo } from "./lib/bump.mjs";
import { CORE } from "./lib/engine.mjs";
import { appendFile } from "./lib/registry.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const next = (process.argv[2] ?? "").replace(/^v/, "");

let plan;
try {
  plan = planEngineBump(readRepo(ROOT), next);
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exit(1);
}

const written = applyEngineBump(ROOT, plan);
if (!plan.changed) {
  console.log(`::notice::${CORE} ${next}: nothing to change (${plan.reason})`);
} else {
  console.log(`${CORE} ${plan.reason}: pin ${plan.range}`);
  if (plan.lineChanged) {
    console.log(`new release line: package floor ${plan.floor}, MIN_CORE_VERSION ${plan.minCore}`);
  }
  for (const file of written) console.log(`  wrote ${file}`);
}

appendFile(
  "GITHUB_OUTPUT",
  `changed=${plan.changed}\nline_changed=${Boolean(plan.lineChanged)}\nversion=${next}\n`,
);
appendFile(
  "GITHUB_STEP_SUMMARY",
  plan.changed
    ? `Bumped \`${CORE}\` ${plan.reason}: every package pins \`${plan.range}\`${plan.lineChanged ? `, the packages move to \`${plan.floor}\` and the runtime floor to \`${plan.minCore}\`` : ""}.\n\n`
    : `\`${CORE}\` ${next}: ${plan.reason}; nothing to commit.\n\n`,
);
