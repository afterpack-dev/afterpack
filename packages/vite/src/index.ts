import { join, resolve } from "node:path";
import { processBatch, version } from "@afterpack/core";
import {
  type AfterpackPluginOptions,
  applyBundleOutput,
  type CapturedDirective,
  type CapturedModule,
  collectBundleJs,
  createTelemetryReporter,
  type OutputBundleLike,
  passSettings,
  resolveClientIdentity,
  resolvePluginConfig,
  runObfuscationPass,
  scanDirectives,
  type WriteProtectionReceiptInput,
  writeDeferredProtectionReceipt,
} from "@afterpack/integration-utils";
import type { Plugin, ResolvedConfig, UserConfig } from "vite";

export type AfterpackViteOptions = AfterpackPluginOptions & {
  leg?: string;
  projectRoot?: string;
};

const LOCAL_KEYS = ["leg", "projectRoot"] as const;

const PATHS_INCLUDE_UNSUPPORTED =
  "this plugin obfuscates the bundler's own output bundle, in the pipeline — there is no " +
  "output-directory walk for a glob to re-admit anything into. Use `npx afterpack <dir> " +
  "--paths.include=...` for a disk walk, or drop the key.";

export function afterpackVite(options: AfterpackViteOptions = {}): Plugin {
  const resolved = resolvePluginConfig({
    label: "afterpack-vite",
    options,
    localKeys: LOCAL_KEYS,
    unsupported: { "paths.include": PATHS_INCLUDE_UNSUPPORTED },
  });
  const settings = resolved.options;
  const artifactOptions = settings.artifactOptions;
  const autorun = settings.build?.autorun ?? true;
  const directivesEnabled = settings.directives.enabled;
  let outDir = "";
  let root = "";
  let buildSourcemap = false;
  const preMinifyCaptureByModuleId = new Map<
    string,
    { source: string; directives: CapturedDirective[]; renameGlobals: boolean }
  >();
  const captureDiagnostics: string[] = [];
  const deferredReceiptByOutDir = new Map<string, WriteProtectionReceiptInput>();

  const leg = options.leg;
  const label = leg ? `afterpack-vite:${leg}` : "afterpack-vite";

  return {
    name: label,
    enforce: "pre",

    config(config: UserConfig) {
      if (
        artifactOptions.protectionMap?.enabled === true &&
        config.build?.sourcemap === undefined
      ) {
        return { build: { sourcemap: true } };
      }
      return undefined;
    },

    configResolved(config: ResolvedConfig) {
      root = config.root;
      outDir = resolve(config.root, config.build.outDir);
      buildSourcemap = Boolean(config.build.sourcemap);
    },

    transform(code: string, id: string) {
      if (!directivesEnabled) return null;
      if (id.codePointAt(0) === 0 || id.includes("/node_modules/")) return null;
      if (!/\.(?:m?[jt]sx?)(?:\?.*)?$/.test(id)) return null;
      if (!code.includes("@afterpack")) return null;
      const scan = scanDirectives(code);
      if (scan.directives.length > 0 || scan.renameGlobals) {
        preMinifyCaptureByModuleId.set(id, {
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

    generateBundle: {
      order: "post",
      async handler(_outputOptions, bundle) {
        if (!autorun) return;
        if (!outDir) return;

        const startedAt = Date.now();
        const projectRoot = options.projectRoot ?? root ?? outDir;
        const { files, inputs, entries } = collectBundleJs(
          bundle as unknown as OutputBundleLike,
          outDir,
        );
        if (files.length === 0) return;

        const capturedByFile = new Map<string, CapturedModule[]>();
        if (preMinifyCaptureByModuleId.size > 0) {
          for (const [filePath, entry] of entries) {
            const mods: CapturedModule[] = [];
            for (const id of Object.keys(entry.modules ?? {})) {
              const cap = preMinifyCaptureByModuleId.get(id);
              if (cap && (cap.directives.length > 0 || cap.renameGlobals)) {
                mods.push({
                  id,
                  source: cap.source,
                  directives: cap.directives,
                  renameGlobals: cap.renameGlobals,
                });
              }
            }
            if (mods.length > 0) capturedByFile.set(filePath, mods);
          }
        }
        for (const message of captureDiagnostics) {
          console.warn(`[${label}] directive ${message}`);
        }
        captureDiagnostics.length = 0;

        const result = await runObfuscationPass({
          files,
          inputs,
          emitToCaller: true,
          engine: { processBatch, version },
          client: resolveClientIdentity(import.meta.url),
          telemetry: createTelemetryReporter(),
          label,
          gitignoreDir: projectRoot,
          buildLeg: leg,
          startedAt,
          capturedByFile: capturedByFile.size > 0 ? capturedByFile : undefined,
          combinedProtectionMap: {
            buildDir: outDir,
            afterpackDir: leg
              ? join(projectRoot, ".afterpack", leg)
              : join(projectRoot, ".afterpack"),
          },
          ...passSettings(resolved),
          hasBundlerSourcemap: buildSourcemap,
          messages: {
            autoEnableBundlerSourcemap:
              "protectionMap:true but no bundler sourcemap was found; enabled build.sourcemap " +
              "so future builds can render original source in the map.",
          },
        });

        for (const out of result.outputs ?? []) {
          const entry = entries.get(out.path);
          if (entry) {
            applyBundleOutput(bundle as unknown as OutputBundleLike, entry, out, result.policy);
          }
        }
        if (result.deferredReceipt) deferredReceiptByOutDir.set(outDir, result.deferredReceipt);
      },
    },

    writeBundle() {
      const deferred = deferredReceiptByOutDir.get(outDir);
      if (!deferred) return;
      deferredReceiptByOutDir.delete(outDir);
      try {
        const receiptPath = writeDeferredProtectionReceipt(deferred);
        if (receiptPath && settings.diagnostics?.level !== "none") {
          console.log(`[${label}] wrote protection receipt -> ${receiptPath} (afterpack verify)`);
        }
      } catch (error) {
        console.warn(
          `[${label}] failed to write protection receipt: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}
