import type { AfterpackPluginOptions } from "@afterpack/integration-utils";
import { afterpackVite } from "@afterpack/vite";
import type { Plugin } from "vite";

export type AfterpackVueOptions = AfterpackPluginOptions;

export function afterpackVue(options: AfterpackVueOptions = {}): Plugin {
  return afterpackVite(options);
}
