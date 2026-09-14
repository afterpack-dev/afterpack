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
