// Build step for the legacy require.js/AMD fixture: stage src/ into dist/, then
// run the `afterpack` CLI over dist/modules/ ONLY (the app's AMD modules) --
// require.js itself stays pristine (vendored, served from dist/require.js).
// --build.backup=false keeps original source out of the served tree. Honors
// AFTERPACK_build_autorun=false (the smoke test's un-obfuscated baseline).
import { execFileSync } from "node:child_process";
import { cpSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED = "641928375";
const src = join(HERE, "src");
const dist = join(HERE, "dist");

rmSync(dist, { recursive: true, force: true });
cpSync(src, dist, { recursive: true });

if (process.env.AFTERPACK_build_autorun !== "false") {
  const cli = createRequire(import.meta.url).resolve("afterpack");
  execFileSync("node", [cli, join(dist, "modules"), `--seed=${SEED}`, "--build.backup=false"], {
    stdio: "inherit",
  });
}
