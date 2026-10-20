import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

const distDir = process.env.AFTERPACK_E2E_DIST_DIR || "build";

export default {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({ pages: distDir, assets: distDir }),
    outDir: process.env.AFTERPACK_E2E_KIT_DIR || ".svelte-kit",
    version: { name: "afterpack-fixture" },
  },
};
