import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "e2e/**"],
    alias: {
      "@afterpack/core": fileURLToPath(new URL("../../test/core-fake.ts", import.meta.url)),
      "@afterpack/integration-utils": fileURLToPath(
        new URL("../integration-utils/src/index.ts", import.meta.url),
      ),
    },
  },
});
