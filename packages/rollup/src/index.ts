import { createHash } from "node:crypto";
import { dirname } from "node:path";
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
  stripBundleCssSourceMaps,
  unsaltedAssetsWarning,
  type WriteProtectionReceiptInput,
  writeDeferredProtectionReceipt,
} from "@afterpack/integration-utils";
import type { NormalizedOutputOptions, OutputBundle, Plugin } from "rollup";

const PATHS_INCLUDE_UNSUPPORTED =
  "this plugin obfuscates Rollup's own bundle, in the pipeline — there is no output-directory " +
  "walk for a glob to re-admit anything into. Use `npx afterpack@latest <dir> " +
  "--paths.include=...` for a disk walk, or drop the key.";

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
  const autorun = settings.build?.autorun ?? true;
  const directivesEnabled = settings.directives.enabled;
  const preMinifyCapturedModulesById = new Map<
    string,
    { source: string; directives: CapturedDirective[]; renameGlobals: boolean }
  >();
  const captureDiagnostics: string[] = [];
  const deferredReceiptByOutDir = new Map<string, WriteProtectionReceiptInput>();
  const hashSaltByOutDir = new Map<string, PreparedHashSalt>();
  let latestSalt: string | undefined;

  const directiveSalt = (moduleIds: readonly string[] | undefined): string => {
    if (!moduleIds || preMinifyCapturedModulesById.size === 0) return "";
    const parts: string[] = [];
    for (const id of moduleIds) {
      const cap = preMinifyCapturedModulesById.get(id);
      if (cap && (cap.directives.length > 0 || cap.renameGlobals)) {
        parts.push(JSON.stringify({ id, d: cap.directives, g: cap.renameGlobals }));
      }
    }
    if (parts.length === 0) return "";
    return createHash("sha256").update(parts.sort().join("\0")).digest("hex").slice(0, 16);
  };

  return {
    name: "afterpack-rollup",

    buildStart() {
      hashSaltByOutDir.clear();
      latestSalt = undefined;
    },

    async renderStart(outputOptions: NormalizedOutputOptions) {
      if (!autorun) return;
      const outDir = outputDir(outputOptions);
      if (!outDir) return;
      const prepared = await prepareHashSalt({
        seed: settings.seed,
        root: process.cwd(),
        leg: outDir,
        localEngineVersion: await readEngineVersion({ version }),
        settings: saltSettings(passSettings(resolved), {
          ...reportPolicySaltBits(
            process.env,
            settings.artifactOptions,
            Boolean(outputOptions.sourcemap),
          ),
        }),
        warn: (message) => console.warn(message),
      });
      hashSaltByOutDir.set(outDir, prepared);
      latestSalt = prepared.salt;
    },

    augmentChunkHash(chunk?: { moduleIds?: readonly string[] }) {
      if (latestSalt === undefined) return undefined;
      return latestSalt + directiveSalt(chunk?.moduleIds);
    },

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
        const unsalted = unsaltedAssetsWarning(entries, new Set());
        if (unsalted) console.warn(`[afterpack-rollup] ${unsalted}`);

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
        const result = await runObfuscationPass({
          files,
          inputs,
          emitToCaller: true,
          engine: { processBatch, version },
          client: resolveClientIdentity(import.meta.url),
          telemetry: createTelemetryReporter(),
          label: "afterpack-rollup",
          cwd,
          resolvedSeed: hashSaltByOutDir.get(outDir)?.resolvedSeed,
          cloudEngineExpectation: hashSaltByOutDir.get(outDir)?.engine,
          startedAt: startedBeforeBundleWalk,
          capturedByFile: capturedByFile.size > 0 ? capturedByFile : undefined,
          combinedProtectionMap: { buildDir: outDir },
          ...passSettings(resolved),
          sourceType: sourceTypeForBundle(outputOptions.format, entries.values()),
          hasBundlerSourcemap: Boolean(outputOptions.sourcemap),
          receipt: { bundler: "rollup" },
          messages: {
            autoEnableBundlerSourcemap:
              "protectionMap:true but no bundler sourcemap was found; set `output.sourcemap: true` " +
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
        regenerateCompressedSiblings(
          bundle as unknown as OutputBundleLike,
          obfuscated,
          "afterpack-rollup",
        );
        if (result.deferredReceipt) deferredReceiptByOutDir.set(outDir, result.deferredReceipt);
      },
    },

    writeBundle(outputOptions: NormalizedOutputOptions) {
      const outDir = outputDir(outputOptions);
      const deferred = outDir ? deferredReceiptByOutDir.get(outDir) : undefined;
      if (!outDir || !deferred) return;
      deferredReceiptByOutDir.delete(outDir);
      try {
        const receiptPath = writeDeferredProtectionReceipt(deferred);
        if (receiptPath && settings.diagnostics?.level !== "none") {
          console.log(
            `[afterpack-rollup] wrote protection receipt -> ${receiptPath} (afterpack verify)`,
          );
        }
      } catch (error) {
        console.warn(
          `[afterpack-rollup] failed to write protection receipt: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}
