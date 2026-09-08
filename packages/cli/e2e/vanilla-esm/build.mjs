// Build step for the no-bundler vanilla-ESM fixture: there is nothing to bundle,
// so "build" == stage src/ into dist/, then run the `afterpack` CLI over dist/
// to obfuscate every emitted module in place. Honors AFTERPACK_build_autorun=false (the
// smoke test's un-obfuscated baseline) by staging without running the CLI --
// mirroring how the plugin fixtures gate their auto-run.
import { execFileSync } from "node:child_process";
import { cpSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED = "518273649";
const src = join(HERE, "src");
const dist = join(HERE, "dist");

rmSync(dist, { recursive: true, force: true });
cpSync(src, dist, { recursive: true });

// --build.backup=false: the dist/ is the served/deployed tree, so the CLI must not leave
// a `.backup.<hash>` (original source verbatim) beside each obfuscated module.
if (process.env.AFTERPACK_build_autorun !== "false") {
  const cli = createRequire(import.meta.url).resolve("afterpack");
  execFileSync("node", [cli, dist, `--seed=${SEED}`, "--build.backup=false"], { stdio: "inherit" });
}
