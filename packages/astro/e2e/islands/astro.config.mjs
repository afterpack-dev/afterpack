import { readFileSync } from "node:fs";
import afterpack from "@afterpack/astro";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";

const expectations = JSON.parse(
  readFileSync(new URL("./expectations.json", import.meta.url), "utf8"),
);
const distDir = process.env.AFTERPACK_E2E_DIST_DIR || "dist";

export default defineConfig({
  outDir: distDir,
  cacheDir: `node_modules/.astro-${distDir}`,
  prefetch: { prefetchAll: true, defaultStrategy: "load" },
  integrations: [react(), afterpack({ seed: Number(process.env.AFTERPACK_E2E_SEED || expectations.seed) })],
});
