import { readFileSync } from "node:fs";
import { afterpackSveltekit } from "@afterpack/sveltekit";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

const expectations = JSON.parse(
  readFileSync(new URL("./expectations.json", import.meta.url), "utf8"),
);

// SvelteKit builds through Vite; @afterpack/sveltekit (over @afterpack/vite) runs
// on closeBundle, so the emitted client bundle is obfuscated before the static
// adapter copies it into build/. Place it AFTER sveltekit().
export default defineConfig({
  plugins: [sveltekit(), afterpackSveltekit({ seed: expectations.seed })],
});
