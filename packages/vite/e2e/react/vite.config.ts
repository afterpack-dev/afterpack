import { readFileSync } from "node:fs";
import { afterpackVite } from "@afterpack/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const expectations = JSON.parse(readFileSync(new URL("./expectations.json", import.meta.url), "utf8"));

// Protection-map review mode: `AFTERPACK_REVIEW_PM=1` forces the Protection
// Map ON even in this production build (it otherwise flips OFF, since a served
// dist must never embed original source). Force-enabling routes it to a
// gitignored `.afterpack/protectionMap.html` + a loud warning -- reviewable,
// never served. Unset = default consumer behavior (prod-off).
const reviewProtectionMap = process.env.AFTERPACK_REVIEW_PM === "1" ? true : undefined;

// https://vite.dev/config/
export default defineConfig({
  build: { sourcemap: true },
  plugins: [
    react(),
    afterpackVite({
      seed: expectations.seed,
      protectionMap: reviewProtectionMap,
      sourceMap: { enabled: true },
    }),
  ],
});
