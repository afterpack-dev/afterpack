// Build step for the single-file CLI fixture: there is nothing to bundle, so
// "build" == copy src/cli.js to dist/cli.js, then point the `afterpack` CLI at
// dist/. That leaves the pass with EXACTLY ONE input file -- the shape every
// other CLI fixture (vanilla-esm, requirejs-amd) never exercises, and the shape
// per-file CLI directive capture will be built on. Honors AFTERPACK_build_autorun=false
// (the smoke test's un-obfuscated baseline) by staging without running the CLI.
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

// --build.backup=false: dist/ is the shipped tree, so the CLI must not leave a
// `.backup.<hash>` (the original source verbatim) beside the obfuscated program.
if (process.env.AFTERPACK_build_autorun !== "false") {
  const cli = createRequire(import.meta.url).resolve("afterpack");
  execFileSync(
    process.execPath,
    [cli, dist, `--seed=${expectations.seed}`, "--build.backup=false"],
    { cwd: HERE, stdio: "inherit" },
  );
}
