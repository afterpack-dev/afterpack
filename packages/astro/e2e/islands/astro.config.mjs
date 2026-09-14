import { readFileSync } from "node:fs";
import afterpack from "@afterpack/astro";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";

const expectations = JSON.parse(
  readFileSync(new URL("./expectations.json", import.meta.url), "utf8"),
);

export default defineConfig({
  integrations: [react(), afterpack({ seed: expectations.seed })],
});
