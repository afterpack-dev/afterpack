import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterpackAngular } from "@afterpack/angular";

const HERE = dirname(fileURLToPath(import.meta.url));
const expectations = JSON.parse(readFileSync(join(HERE, "expectations.json"), "utf8"));
const ng = join(HERE, "node_modules", "@angular", "cli", "bin", "ng.js");

execFileSync(process.execPath, [ng, "build", "--configuration", "production"], {
  cwd: HERE,
  stdio: "inherit",
  env: { ...process.env, NG_CLI_ANALYTICS: "false" },
});

if (process.env.AFTERPACK_build_autorun !== "false") {
  await afterpackAngular({ cwd: HERE, seed: expectations.seed, protectionMap: true });
}
