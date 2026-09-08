import { readFileSync } from "node:fs";
import { afterpackSvelte } from "@afterpack/svelte";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

const expectations = JSON.parse(
  readFileSync(new URL("./expectations.json", import.meta.url), "utf8"),
);

// Plain Svelte SPA (NOT SvelteKit -- ../sveltekit/ covers that), obfuscated
// automatically via @afterpack/svelte, the thin wrapper over @afterpack/vite's
// closeBundle hook.
export default defineConfig({
  plugins: [svelte(), afterpackSvelte({ seed: expectations.seed })],
});
