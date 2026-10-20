import { readFileSync } from "node:fs";
import { afterpackVite } from "@afterpack/vite";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

const expectations = JSON.parse(readFileSync(new URL("./expectations.json", import.meta.url), "utf8"));

export default defineConfig({
  plugins: [
    reactRouter(),
    afterpackVite({ seed: Number(process.env.AFTERPACK_E2E_SEED || expectations.seed) }),
  ],
});
