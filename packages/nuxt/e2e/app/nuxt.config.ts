import { readFileSync } from "node:fs";

const expectations = JSON.parse(
  readFileSync(new URL("./expectations.json", import.meta.url), "utf8"),
);

// Minimal Nuxt 3 static/prerendered app. `@afterpack/nuxt` registers
// `@afterpack/vite` on Nuxt's Vite config, obfuscating the client bundle on
// closeBundle; nuxt generate then prerenders into .output/public. buildId is
// pinned for deterministic output across repeated builds.
export default defineNuxtConfig({
  modules: ["@afterpack/nuxt"],
  afterpack: { seed: expectations.seed },
  ssr: true,
  buildId: "afterpack-fixture",
  compatibilityDate: "2024-11-01",
  nitro: { prerender: { routes: ["/"], crawlLinks: false } },
});
