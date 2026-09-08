import type { AfterpackPluginOptions } from "@afterpack/integration-utils";
import { afterpackVite } from "@afterpack/vite";
import type { Plugin } from "vite";

export type AfterpackSveltekitOptions = AfterpackPluginOptions;

export function afterpackSveltekit(options: AfterpackSveltekitOptions = {}): Plugin {
  return afterpackVite(options);
}
