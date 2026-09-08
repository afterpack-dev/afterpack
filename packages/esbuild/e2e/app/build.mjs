// esbuild build for the esbuild-app fixture, obfuscated by @afterpack/esbuild.
// Bundles src/main.js -> dist/app.js (single ESM outfile); the plugin's onEnd
// hook obfuscates it in place. It honors AFTERPACK_build_autorun=false itself (the harness
// un-obfuscated baseline), so no branch is needed here. build.backup:false keeps the
// served dist/ clean. Seed comes from expectations.json for deterministic builds.
import { readFileSync } from "node:fs";
import { afterpackEsbuild } from "@afterpack/esbuild";
import { build } from "esbuild";

const expectations = JSON.parse(
  readFileSync(new URL("./expectations.json", import.meta.url), "utf8"),
);

await build({
  entryPoints: ["src/main.js"],
  bundle: true,
  format: "esm",
  outfile: "dist/app.js",
  plugins: [afterpackEsbuild({ seed: expectations.seed, build: { backup: false } })],
});
