import { readFileSync } from "node:fs";
import { afterpackVue } from "@afterpack/vue";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const expectations = JSON.parse(
  readFileSync(new URL("./expectations.json", import.meta.url), "utf8"),
);

// https://vite.dev/config/ -- Vue 3 SPA, obfuscated automatically via
// @afterpack/vue (the thin wrapper over @afterpack/vite's closeBundle hook).
export default defineConfig({
  plugins: [vue(), afterpackVue({ seed: expectations.seed })],
});
