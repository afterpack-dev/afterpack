import { readFileSync } from "node:fs";
import { afterpackEsbuild } from "@afterpack/esbuild";
import { build } from "esbuild";

const expectations = JSON.parse(
  readFileSync(new URL("./expectations.json", import.meta.url), "utf8"),
);

await build({
  entryPoints: { app: "src/main.js" },
  bundle: true,
  format: "esm",
  splitting: true,
  outdir: "dist",
  chunkNames: "chunks/[name]-[hash]",
  plugins: [afterpackEsbuild({ seed: Number(process.env.AFTERPACK_E2E_SEED || expectations.seed), build: { backup: false } })],
});
