import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { processBatch, version } from "@afterpack/core";
import {
  type AfterpackPluginOptions,
  applyBundleOutput,
  type CapturedDirective,
  type CapturedModule,
  collectBundleJs,
  createTelemetryReporter,
  type OutputBundleLike,
  type PreparedHashSalt,
  passSettings,
  prepareHashSalt,
  readEngineVersion,
  regenerateCompressedSiblings,
  reportPolicySaltBits,
  resolveClientIdentity,
  resolvePluginConfig,
  runObfuscationPass,
  saltSettings,
  scanDirectives,
  sourceTypeForBundle,
  sriPluginRefusal,
  stripBundleCssSourceMaps,
  unsaltedAssetsWarning,
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
  let building = false;
  const preMinifyCaptureByModuleId = new Map<
    string,
    { source: string; directives: CapturedDirective[]; renameGlobals: boolean }
  >();
  const captureDiagnostics: string[] = [];
  const deferredReceiptByOutDir = new Map<string, WriteProtectionReceiptInput>();
  const workerOutputs = new Set<string>();
  let hashSalt: PreparedHashSalt | null = null;

  const leg = options.leg;
  const label = leg ? `afterpack-vite:${leg}` : "afterpack-vite";

  const directiveSalt = (moduleIds: readonly string[] | undefined): string => {
    if (!moduleIds || preMinifyCaptureByModuleId.size === 0) return "";
    const parts: string[] = [];
    for (const id of moduleIds) {
      const cap = preMinifyCaptureByModuleId.get(id);
      if (cap && (cap.directives.length > 0 || cap.renameGlobals)) {
        parts.push(JSON.stringify({ id, d: cap.directives, g: cap.renameGlobals }));
      }
    }
    if (parts.length === 0) return "";
    return createHash("sha256").update(parts.sort().join("\0")).digest("hex").slice(0, 16);
  };
  const chunkSalt = (moduleIds: readonly string[] | undefined): string | undefined =>
    hashSalt ? hashSalt.salt + directiveSalt(moduleIds) : undefined;

  const workerNamesPlugin: Plugin = {
    name: `${label}:worker-names`,
    augmentChunkHash(chunk?: { moduleIds?: readonly string[] }) {
      return chunkSalt(chunk?.moduleIds);
    },
    generateBundle(_outputOptions, bundle) {
      for (const fileName of Object.keys(bundle)) workerOutputs.add(fileName);
    },
  };

  return {
    name: label,
    enforce: "pre",

    config(config: UserConfig) {
      const overrides: UserConfig = {};
      if (
        artifactOptions.protectionMap?.enabled === true &&
        config.build?.sourcemap === undefined
      ) {
        overrides.build = { sourcemap: true };
      }
      if (autorun) {
        const userWorkerPlugins = config.worker?.plugins;
        overrides.worker = {
          plugins: () => [...(userWorkerPlugins?.() ?? []), workerNamesPlugin],
        };
      }
      return overrides;
    },

    configResolved(config: ResolvedConfig) {
      root = config.root;
      outDir = resolve(config.root, config.build.outDir);
      buildSourcemap = Boolean(config.build.sourcemap);
      building = config.command === "build";
      if (autorun && building) {
        const refusal = sriPluginRefusal(config.plugins as { name?: string }[], label);
        if (refusal) throw new Error(refusal);
      }
    },

    async buildStart() {
      hashSalt = null;
      workerOutputs.clear();
      if (!autorun || !building || !outDir) return;
      hashSalt = await prepareHashSalt({
        seed: settings.seed,
        root: options.projectRoot ?? root ?? outDir,
        leg: leg ?? outDir,
        localEngineVersion: await readEngineVersion({ version }),
        settings: saltSettings(passSettings(resolved), {
          ...reportPolicySaltBits(process.env, artifactOptions, buildSourcemap),
        }),
        warn: (message) => console.warn(message),
      });
    },

    augmentChunkHash(chunk?: { moduleIds?: readonly string[] }) {
      return chunkSalt(chunk?.moduleIds);
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
      async handler(outputOptions, bundle) {
        if (!autorun) return;
        if (!outDir) return;

        const startedAt = Date.now();
        const projectRoot = options.projectRoot ?? root ?? outDir;
        const { files, inputs, entries } = collectBundleJs(
          bundle as unknown as OutputBundleLike,
          outDir,
        );
        if (files.length === 0) return;
        const unsalted = unsaltedAssetsWarning(entries, workerOutputs);
        if (unsalted) console.warn(`[${label}] ${unsalted}`);

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
          cwd: projectRoot,
          buildLeg: leg,
          resolvedSeed: hashSalt?.resolvedSeed,
          cloudEngineExpectation: hashSalt?.engine,
          startedAt,
          capturedByFile: capturedByFile.size > 0 ? capturedByFile : undefined,
          combinedProtectionMap: { buildDir: outDir, subdir: leg },
          ...passSettings(resolved),
          sourceType: sourceTypeForBundle(outputOptions.format, entries.values()),
          hasBundlerSourcemap: buildSourcemap,
          messages: {
            autoEnableBundlerSourcemap:
              "protectionMap:true but no bundler sourcemap was found; enabled build.sourcemap " +
              "so future builds can render original source in the map.",
          },
        });

        const obfuscated = new Set<string>();
        for (const out of result.outputs ?? []) {
          const entry = entries.get(out.path);
          if (entry) {
            applyBundleOutput(bundle as unknown as OutputBundleLike, entry, out, result.policy);
            obfuscated.add(entry.fileName);
          }
        }
        if (!result.policy.sourceMap) {
          stripBundleCssSourceMaps(bundle as unknown as OutputBundleLike);
        }
        regenerateCompressedSiblings(bundle as unknown as OutputBundleLike, obfuscated, label);
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
