import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const expectations = JSON.parse(readFileSync(join(HERE, "expectations.json"), "utf8"));
const SEED = process.env.AFTERPACK_E2E_SEED || String(expectations.seed);

execFileSync(process.execPath, [require.resolve("next/dist/bin/next"), "build"], {
  cwd: HERE,
  stdio: "inherit",
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
});

if (process.env.AFTERPACK_build_autorun !== "false") {
  execFileSync(
    process.execPath,
    [require.resolve("afterpack"), ".next/static/chunks", `--seed=${SEED}`, "--build.backup=false"],
    { cwd: HERE, stdio: "inherit" },
  );
}
