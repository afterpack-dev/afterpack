import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    alias: {
      "@afterpack/network-core": fileURLToPath(
        new URL("../network-core/src/index.ts", import.meta.url),
      ),
    },
  },
});
