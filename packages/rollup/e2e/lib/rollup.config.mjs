import { readFileSync } from "node:fs";
import { afterpackRollup } from "@afterpack/rollup";

const expectations = JSON.parse(
  readFileSync(new URL("./expectations.json", import.meta.url), "utf8"),
);

export default {
  input: "src/index.js",
  output: [
    { dir: "dist/esm", format: "es", entryFileNames: "lib.js", chunkFileNames: "[name]-[hash].js" },
    { dir: "dist/cjs", format: "cjs", entryFileNames: "lib.cjs", chunkFileNames: "[name]-[hash].cjs" },
  ],
  plugins: [afterpackRollup({ seed: Number(process.env.AFTERPACK_E2E_SEED || expectations.seed), build: { backup: false } })],
};
