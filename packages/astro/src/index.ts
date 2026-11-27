import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { AfterpackConfig, AfterpackPluginOptions } from "@afterpack/integration-utils";
import { afterpackVite } from "@afterpack/vite";
import {
  ASTRO_POST_BUILD_PLACEHOLDERS,
  assertPlaceholdersPinned,
  findAstroPlaceholders,
} from "./placeholders.js";

export type AfterpackAstroOptions = AfterpackPluginOptions;

const ASTRO = "astro";

const SERVER_VITE_ENVIRONMENT_NAMES = ["ssr", "prerender"];

function assertAstroPlaceholdersPinned(): void {
  let distDir: string;
  try {
    distDir = join(dirname(createRequire(import.meta.url).resolve("astro/package.json")), "dist");
  } catch {
    return;
  }
  assertPlaceholdersPinned(findAstroPlaceholders(distDir));
}

interface ConfigSetupParams {
  updateConfig: (config: { vite?: { plugins?: unknown[] } }) => unknown;
}

export interface AfterpackAstroIntegration {
  name: string;
  hooks: {
    "astro:config:setup": (params: ConfigSetupParams) => void;
  };
}

const SERVER_LISTS: AfterpackConfig = {
  strings: { preserveLiterals: [...ASTRO_POST_BUILD_PLACEHOLDERS] },
};

export function afterpackAstro(options: AfterpackAstroOptions = {}): AfterpackAstroIntegration {
  return {
    name: "@afterpack/astro",
    hooks: {
      "astro:config:setup": ({ updateConfig }) => {
        assertAstroPlaceholdersPinned();
        const clientPlugin = {
          ...afterpackVite(options, { framework: ASTRO }),
          applyToEnvironment: (environment: { name: string }) => environment.name === "client",
        };
        const serverPlugin = {
          ...afterpackVite(options, { appendLists: SERVER_LISTS, framework: ASTRO }),
          applyToEnvironment: (environment: { name: string }) =>
            SERVER_VITE_ENVIRONMENT_NAMES.includes(environment.name),
        };
        updateConfig({ vite: { plugins: [clientPlugin, serverPlugin] } });
      },
    },
  };
}

export default afterpackAstro;
