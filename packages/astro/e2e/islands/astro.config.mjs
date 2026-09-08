// @ts-check

import { readFileSync } from "node:fs";
import afterpack from "@afterpack/astro";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";

const expectations = JSON.parse(
  readFileSync(new URL("./expectations.json", import.meta.url), "utf8"),
);

// https://astro.build/config
export default defineConfig({
  // This fixture builds in static (SSG) mode: the only emitted JS is the React
  // island bundle under dist/_astro/, which Astro produces via its own Vite
  // pipeline. @afterpack/astro is a REAL, thin Astro integration -- it injects
  // @afterpack/vite into Astro's Vite config via the `astro:config:setup` hook,
  // so no manual `vite.plugins` wiring is needed -- scoped to Astro's client
  // environment. It does not cover server-rendered .astro template logic, nor
  // Astro's SSR/prerender chunks, which Astro rewrites by raw string
  // substitution after the whole build (see @afterpack/astro's readme).
  integrations: [react(), afterpack({ seed: expectations.seed })],
});
