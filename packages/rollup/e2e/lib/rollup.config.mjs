// Rollup build for the ESM/CJS library fixture, obfuscated by @afterpack/rollup.
// Two outputs into SEPARATE dirs (dist/esm, dist/cjs) so each is obfuscated once
// by the plugin's writeBundle hook without re-processing the other. build.backup:false
// keeps the emitted lib dir clean (no original-source siblings beside the
// shipped, obfuscated bundle). The seed comes from expectations.json so repeat
// builds are byte-identical (the harness's determinism check).
import { readFileSync } from "node:fs";
import { afterpackRollup } from "@afterpack/rollup";

const expectations = JSON.parse(
  readFileSync(new URL("./expectations.json", import.meta.url), "utf8"),
);

export default {
  input: "src/index.js",
  output: [
    { dir: "dist/esm", format: "es", entryFileNames: "lib.js" },
    { dir: "dist/cjs", format: "cjs", entryFileNames: "lib.cjs" },
  ],
  plugins: [afterpackRollup({ seed: expectations.seed, build: { backup: false } })],
};
