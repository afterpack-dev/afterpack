import type { AfterpackPluginOptions } from "@afterpack/integration-utils";
import { afterpackVite } from "@afterpack/vite";

export type AfterpackAstroOptions = AfterpackPluginOptions;

interface ConfigSetupParams {
  updateConfig: (config: { vite?: { plugins?: unknown[] } }) => unknown;
}

export interface AfterpackAstroIntegration {
  name: string;
  hooks: {
    "astro:config:setup": (params: ConfigSetupParams) => void;
  };
}

export function afterpackAstro(options: AfterpackAstroOptions = {}): AfterpackAstroIntegration {
  return {
    name: "@afterpack/astro",
    hooks: {
      "astro:config:setup": ({ updateConfig }) => {
        const isClientEnvironment = (environment: { name: string }) =>
          environment.name === "client";
        const plugin = {
          ...afterpackVite(options),
          applyToEnvironment: isClientEnvironment,
        };
        updateConfig({ vite: { plugins: [plugin] } });
      },
    },
  };
}

export default afterpackAstro;
