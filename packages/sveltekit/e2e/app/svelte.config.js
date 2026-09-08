import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

// Static (SSG) SvelteKit app. `version.name` is pinned so repeat builds are
// byte-identical (SvelteKit defaults it to Date.now(), which the harness's
// determinism check would otherwise flag).
export default {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    version: { name: "afterpack-fixture" },
  },
};
