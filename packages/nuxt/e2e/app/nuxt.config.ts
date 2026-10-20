import { readFileSync } from "node:fs";

const expectations = JSON.parse(
  readFileSync(new URL("./expectations.json", import.meta.url), "utf8"),
);

export default defineNuxtConfig({
  modules: ["@afterpack/nuxt"],
  afterpack: { seed: Number(process.env.AFTERPACK_E2E_SEED || expectations.seed) },
  ssr: true,
  buildId: "afterpack-fixture",
  buildDir: process.env.AFTERPACK_E2E_BUILD_DIR || ".nuxt",
  compatibilityDate: "2024-11-01",
  nitro: {
    output: { dir: process.env.AFTERPACK_E2E_OUTPUT_DIR || ".output" },
    prerender: { routes: ["/", "/notes", "/reports"], crawlLinks: false },
  },
});
