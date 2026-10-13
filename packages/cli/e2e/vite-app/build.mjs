import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const HERE = dirname(fileURLToPath(import.meta.url));
const expectations = JSON.parse(readFileSync(join(HERE, "expectations.json"), "utf8"));
const SEED = process.env.AFTERPACK_E2E_SEED || String(expectations.seed);

await build({
  root: HERE,
  logLevel: "warn",
  build: { manifest: true, emptyOutDir: true },
});

if (process.env.AFTERPACK_build_autorun !== "false") {
  const cli = createRequire(import.meta.url).resolve("afterpack");
  execFileSync(process.execPath, [cli, "dist", `--seed=${SEED}`, "--build.backup=false"], {
    cwd: HERE,
    stdio: "inherit",
  });
}
