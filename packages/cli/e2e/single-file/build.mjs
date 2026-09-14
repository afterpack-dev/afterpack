import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const expectations = JSON.parse(readFileSync(join(HERE, "expectations.json"), "utf8"));
const dist = join(HERE, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(join(HERE, "src", "cli.js"), join(dist, "cli.js"));
chmodSync(join(dist, "cli.js"), 0o755);

if (process.env.AFTERPACK_build_autorun !== "false") {
  const cli = createRequire(import.meta.url).resolve("afterpack");
  execFileSync(
    process.execPath,
    [cli, dist, `--seed=${expectations.seed}`, "--build.backup=false"],
    { cwd: HERE, stdio: "inherit" },
  );
}
