import { readFileSync } from "node:fs";
import { withAfterpackElectron } from "@afterpack/electron";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const expectations = JSON.parse(
  readFileSync(new URL("./expectations.json", import.meta.url), "utf8"),
);

// The fixture pins a seed so the harness can assert byte-for-byte determinism.
// `AFTERPACK_FI_FREE_SEED=1` un-pins it, which is how the smoke test proves the
// thing this package exists for: three legs, one FRESHLY DRAWN seed.
const seed = process.env.AFTERPACK_FI_FREE_SEED === "1" ? undefined : expectations.seed;

export default withAfterpackElectron(
  defineConfig({
    main: { plugins: [externalizeDepsPlugin()] },
    preload: { plugins: [externalizeDepsPlugin()] },
    renderer: {},
  }),
  { seed },
);
