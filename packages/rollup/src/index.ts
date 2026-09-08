import { dirname, join } from "node:path";
import { processBatch, version } from "@afterpack/core";
import {
  type AfterpackPluginOptions,
  applyBundleOutput,
  type CapturedDirective,
  type CapturedModule,
  collectBundleJs,
  createTelemetryReporter,
  type OutputBundleLike,
  resolvePluginConfig,
  runObfuscationPass,
  scanDirectives,
} from "@afterpack/integration-utils";
import type { NormalizedOutputOptions, OutputBundle, Plugin } from "rollup";

const PATHS_INCLUDE_UNSUPPORTED =
  "this plugin obfuscates Rollup's own bundle, in the pipeline — there is no output-directory " +
  "walk for a glob to re-admit anything into. Use `npx afterpack <dir> --paths.include=...` for " +
  "a disk walk, or drop the key.";

export type AfterpackRollupOptions = AfterpackPluginOptions;

function outputDir(options: NormalizedOutputOptions): string | undefined {
  return options.dir ?? (options.file ? dirname(options.file) : undefined);
}

const FINAL_SEAL_ORDER = "post";

export function afterpackRollup(options: AfterpackRollupOptions = {}): Plugin {
  const resolved = resolvePluginConfig({
    label: "afterpack-rollup",
    options,
    unsupported: { "paths.include": PATHS_INCLUDE_UNSUPPORTED },
  });
  const settings = resolved.options;
  const artifactOptions = settings.artifactOptions;
  const autorun = settings.build?.autorun ?? true;
  const directivesEnabled = settings.directives;
  const preMinifyCapturedModulesById = new Map<
    string,
    { source: string; directives: CapturedDirective[]; renameGlobals: boolean }
  >();
  const captureDiagnostics: string[] = [];

  return {
    name: "afterpack-rollup",

    transform: {
      order: "pre",
      handler(code: string, id: string) {
        if (!directivesEnabled) return null;
        if (id.codePointAt(0) === 0 || id.includes("/node_modules/")) return null;
        if (!/\.(?:m?[jt]sx?)(?:\?.*)?$/.test(id)) return null;
        if (!code.includes("@afterpack")) return null;
        const scan = scanDirectives(code);
        if (scan.directives.length > 0 || scan.renameGlobals) {
          preMinifyCapturedModulesById.set(id, {
            source: code,
            directives: scan.directives,
            renameGlobals: scan.renameGlobals,
          });
        }
        for (const d of scan.diagnostics) {
          captureDiagnostics.push(`${id} (${d.line}:${d.column}): ${d.message}`);
        }
        return null;
      },
    },

    generateBundle: {
      order: FINAL_SEAL_ORDER,
      async handler(outputOptions: NormalizedOutputOptions, bundle: OutputBundle) {
        if (!autorun) return;
        const outDir = outputDir(outputOptions);
        if (!outDir) return;

        const startedBeforeBundleWalk = Date.now();
        const { files, inputs, entries } = collectBundleJs(
          bundle as unknown as OutputBundleLike,
          outDir,
        );
        if (files.length === 0) return;

        const capturedByFile = new Map<string, CapturedModule[]>();
        if (preMinifyCapturedModulesById.size > 0) {
          for (const [filePath, entry] of entries) {
            const mods: CapturedModule[] = [];
            for (const id of Object.keys(entry.modules ?? {})) {
              const cap = preMinifyCapturedModulesById.get(id);
              if (!cap) continue;
              const shouldForwardCapturedModule = cap.directives.length > 0 || cap.renameGlobals;
              if (!shouldForwardCapturedModule) continue;
              mods.push({
                id,
                source: cap.source,
                directives: cap.directives,
                renameGlobals: cap.renameGlobals,
              });
            }
            if (mods.length > 0) capturedByFile.set(filePath, mods);
          }
        }
        for (const message of captureDiagnostics) {
          console.warn(`[afterpack-rollup] directive ${message}`);
        }
        captureDiagnostics.length = 0;

        const cwd = process.cwd();
        const gitignoredNonServedAfterpackDir = join(cwd, ".afterpack");
        const result = await runObfuscationPass({
          files,
          inputs,
          emitToCaller: true,
          engine: { processBatch, version },
          telemetry: createTelemetryReporter(),
          label: "afterpack-rollup",
          gitignoreDir: cwd,
          startedAt: startedBeforeBundleWalk,
          capturedByFile: capturedByFile.size > 0 ? capturedByFile : undefined,
          combinedProtectionMap: {
            buildDir: outDir,
            afterpackDir: gitignoredNonServedAfterpackDir,
          },
          artifactOptions,
          hasBundlerSourcemap: Boolean(outputOptions.sourcemap),
          seed: settings.seed,
          preset: settings.preset,
          complexity: settings.complexity,
          regions: settings.regions,
          engineConfig: resolved.engineConfig,
          diagnostics: settings.diagnostics?.level,
          directives: directivesEnabled,
          directivesExplicit: settings.directivesExplicit,
          messages: {
            autoEnableBundlerSourcemap:
              "protectionMap:true but no bundler sourcemap was found; set `output.sourcemap: true` " +
              "so future builds can render original source in the map.",
          },
        });

        for (const out of result.outputs ?? []) {
          const entry = entries.get(out.filePath);
          if (entry) {
            applyBundleOutput(bundle as unknown as OutputBundleLike, entry, out, result.policy);
          }
        }
      },
    },
  };
}
