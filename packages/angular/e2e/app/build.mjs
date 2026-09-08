// Build step for the Angular fixture. Modern Angular (v17+) builds via the SEALED
// @angular-devkit/build-angular:application builder (esbuild-based), which exposes
// NO consumer plugin hook -- so the robust AfterPack integration is a postbuild
// pass over the emitted browser bundle (dist/<app>/browser), the canonical Angular
// path.
//
// This fixture drives @afterpack/angular's own `afterpackAngular()` rather than
// the `afterpack` CLI (R-20): the CLI is already covered by vanilla-esm and
// requirejs-amd, while the plugin's published code -- `findAngularBrowserDir`'s
// auto-location and the combined-Protection-Map routing into `.afterpack/` --
// had never run against real `ng build` output. `browserDir` is deliberately NOT
// passed so the locator itself is what finds dist/<app>/browser here.
//
// Honors AFTERPACK_build_autorun=false (the smoke test's un-obfuscated baseline) by running
// `ng build` WITHOUT the obfuscation pass.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterpackAngular } from "@afterpack/angular";

const HERE = dirname(fileURLToPath(import.meta.url));
const expectations = JSON.parse(readFileSync(join(HERE, "expectations.json"), "utf8"));
const ng = join(HERE, "node_modules", "@angular", "cli", "bin", "ng.js");

// 1. Real Angular production build (deletes the output dir first, so every build
//    starts from a clean slate -> the postbuild pass always obfuscates fresh JS).
execFileSync(process.execPath, [ng, "build", "--configuration", "production"], {
  cwd: HERE,
  stdio: "inherit",
  env: { ...process.env, NG_CLI_ANALYTICS: "false" },
});

// 2. Postbuild obfuscation via the plugin. No `build.backup` option: the package
//    already defaults to writing none, which is what keeps dist/ (the deployed
//    tree) free of a verbatim `.backup.<hash>` copy of the original source.
//    `protectionMap: true` is what exercises the package's combinedProtectionMap
//    routing -- `ng build --configuration production` emits no sourcemap, so the
//    map is off by default here and that code path would never run.
if (process.env.AFTERPACK_build_autorun !== "false") {
  await afterpackAngular({ cwd: HERE, seed: expectations.seed, protectionMap: true });
}
