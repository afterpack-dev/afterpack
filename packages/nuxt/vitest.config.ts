import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "e2e/**"],
    alias: {
      "@afterpack/vite": fileURLToPath(new URL("../vite/src/index.ts", import.meta.url)),
    },
  },
});
