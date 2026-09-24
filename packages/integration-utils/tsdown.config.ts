import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: "esm",
    dts: true,
  },
  {
    entry: ["src/index.ts"],
    format: "cjs",
    dts: true,
    shims: true,
    clean: false,
    noExternal: ["@afterpack/protection-map"],
  },
]);
