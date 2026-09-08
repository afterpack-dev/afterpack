import type { AfterpackPluginOptions } from "@afterpack/integration-utils";
import { afterpackVite } from "@afterpack/vite";
import { addVitePlugin, defineNuxtModule } from "@nuxt/kit";

export type AfterpackNuxtOptions = AfterpackPluginOptions;

export default defineNuxtModule<AfterpackNuxtOptions>({
  meta: {
    name: "@afterpack/nuxt",
    configKey: "afterpack",
    compatibility: { nuxt: ">=3.0.0" },
  },
  setup(options) {
    const createFreshPluginPerViteEnvironment = () => afterpackVite(options);
    addVitePlugin(createFreshPluginPerViteEnvironment);
  },
});
