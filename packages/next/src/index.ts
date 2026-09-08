import type { AfterpackPluginOptions } from "@afterpack/integration-utils";
import { type AfterProductionCompileMetadata, runAfterpackHook } from "./hook.js";

export type AfterpackNextOptions = AfterpackPluginOptions;

interface NextConfigSurface {
  compiler?: {
    runAfterProductionCompile?: (metadata: AfterProductionCompileMetadata) => Promise<void>;
  };
  experimental?: { sri?: { algorithm?: string } };
}

type PhaseConfigFn = (...args: unknown[]) => NextConfigSurface | Promise<NextConfigSurface>;

function install(config: NextConfigSurface, options: AfterpackNextOptions): NextConfigSurface {
  const userHook = config.compiler?.runAfterProductionCompile;
  return {
    ...config,
    compiler: {
      ...config.compiler,
      runAfterProductionCompile: async (metadata: AfterProductionCompileMetadata) => {
        if (userHook) await userHook(metadata);
        await runAfterpackHook({
          metadata,
          options,
          sriAlgorithm: config.experimental?.sri?.algorithm,
        });
      },
    },
  };
}

export function withAfterpackNext<T extends object>(
  nextConfig: T,
  options: AfterpackNextOptions = {},
): T {
  if (typeof nextConfig === "function") {
    const produce = nextConfig as unknown as PhaseConfigFn;
    const wrapped: PhaseConfigFn = (...args) => {
      const config = produce(...args);
      return config instanceof Promise
        ? config.then((c) => install(c, options))
        : install(config, options);
    };
    return wrapped as unknown as T;
  }
  return install(nextConfig as T & NextConfigSurface, options) as T;
}
