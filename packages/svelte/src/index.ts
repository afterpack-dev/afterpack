import type { AfterpackPluginOptions } from "@afterpack/integration-utils";
import { afterpackVite } from "@afterpack/vite";
import type { Plugin } from "vite";

export type AfterpackSvelteOptions = AfterpackPluginOptions;

export function afterpackSvelte(options: AfterpackSvelteOptions = {}): Plugin {
  return afterpackVite(options);
}
