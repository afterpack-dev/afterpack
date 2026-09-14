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
