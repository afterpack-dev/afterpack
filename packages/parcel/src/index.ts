import { join } from "node:path";
import type { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { processBatch, version } from "@afterpack/core";
import {
  applyResolvedKey,
  CONFIG_FILE_NAME,
  type CoreConfigSubset,
  createTelemetryReporter,
  extractSourceMappingURL,
  mergeConfig,
  type PluginOptionsView,
  parseEnvOptions,
  resolveClientIdentity,
  runObfuscationPass,
  toEngineConfig,
  toPluginOptions,
  validateConfig,
} from "@afterpack/integration-utils";
import diagnosticExport from "@parcel/diagnostic";
import { Optimizer } from "@parcel/plugin";
import sourceMapExport from "@parcel/source-map";
import type { NamedBundle } from "@parcel/types";

const PLUGIN_NAME = "@afterpack/parcel-optimizer";
const CONFIG_FILES = [CONFIG_FILE_NAME];

interface ParcelConfig {
  options: PluginOptionsView;
  engineConfig: CoreConfigSubset;
}

function interopCjsDefaultExport<T>(mod: T): T {
  return (mod as unknown as { default?: T }).default ?? mod;
}

const SourceMap = interopCjsDefaultExport(sourceMapExport);
const ThrowableDiagnostic = interopCjsDefaultExport(diagnosticExport);

async function blobToString(blob: string | Buffer | Readable): Promise<string> {
  if (typeof blob === "string") return blob;
  if (Buffer.isBuffer(blob)) return blob.toString("utf8");
  return await text(blob);
}

function escapeParcelMarkdown(message: string): string {
  return message.replace(/[\\*_`~]/g, (c) => `\\${c}`);
}

const CONTENT_HASH_REF = /HASH_REF_\w{16}/g;

function contentHashRefsExcludingSourceMapComment(code: string): string[] {
  const refs = new Set(code.match(CONTENT_HASH_REF) ?? []);
  for (const own of extractSourceMappingURL(code)?.match(CONTENT_HASH_REF) ?? []) {
    refs.delete(own);
  }
  return [...refs];
}

function stableBundleStem(bundle: NamedBundle): string {
  const name = bundle.displayName.replace(/\.?\[[^\]]*\]/g, "").replace(/[\\/]/g, "-");
  return `${name}.${bundle.publicId}`;
}

export default new Optimizer<ParcelConfig, void>({
  async loadConfig({ config, options }) {
    const foundViaCacheInvalidatingConfigLookup = await config.getConfigFrom<unknown>(
      join(options.projectRoot, "index"),
      CONFIG_FILES,
    );
    const source = foundViaCacheInvalidatingConfigLookup?.filePath ?? CONFIG_FILE_NAME;
    const fromFile = validateConfig(foundViaCacheInvalidatingConfigLookup?.contents ?? {}, source);
    const fromEnv = parseEnvOptions(options.env);
    const issues = [...fromFile.issues, ...fromEnv.issues];
    if (issues.length > 0) {
      throw new ThrowableDiagnostic({
        diagnostic: {
          message: issues.map((i) => i.message).join("\n"),
          origin: PLUGIN_NAME,
        },
      });
    }
    const mergedWithEnvOutrankingFile = mergeConfig(fromFile.config, fromEnv.config);
    const view = toPluginOptions(mergedWithEnvOutrankingFile);
    if ((view.paths?.include ?? []).length > 0) {
      throw new ThrowableDiagnostic({
        diagnostic: {
          message:
            "`paths.include` is not supported here — an Optimizer is handed each packaged bundle " +
            "in memory, so there is no output-directory walk for a glob to re-admit anything " +
            "into. Use `npx afterpack <dir> --paths.include=...` for a disk walk, or drop the key.",
          origin: PLUGIN_NAME,
        },
      });
    }
    applyResolvedKey(mergedWithEnvOutrankingFile);
    return { options: view, engineConfig: toEngineConfig(mergedWithEnvOutrankingFile) };
  },

  async optimize({ bundle, contents, map, options, logger, config, getSourceMapReference }) {
    const unchanged = { contents, map };
    if (bundle.type !== "js") return unchanged;
    if (!bundle.env.shouldOptimize) return unchanged;
    const autorun = config.options.build?.autorun ?? true;
    if (!autorun) return unchanged;

    const startedAt = Date.now();
    const code = await blobToString(contents);
    const hashRefs = contentHashRefsExcludingSourceMapComment(code);
    const projectedFilePath = join(bundle.target.distDir, bundle.name);
    const bundleLegIdentity = stableBundleStem(bundle);

    const inputSourceMapWithInlinedSources = map
      ? String(
          await map.stringify({
            file: `${bundle.name}.map`,
            fs: options.inputFS,
            rootDir: options.projectRoot,
            inlineSources: true,
            format: "string",
          }),
        )
      : null;

    const gitignoredNonServedAfterpackDir = join(options.projectRoot, ".afterpack");
    const seedEnvCopy = { ...options.env };
    const result = await runObfuscationPass({
      files: [projectedFilePath],
      inputs: new Map([
        [projectedFilePath, { source: code, sourceMap: inputSourceMapWithInlinedSources }],
      ]),
      emitToCaller: true,
      engine: { processBatch, version },
      client: resolveClientIdentity(import.meta.url),
      telemetry: createTelemetryReporter(),
      label: "afterpack-parcel",
      cwd: options.projectRoot,
      startedAt,
      combinedProtectionMap: {
        buildDir: bundle.target.distDir,
        afterpackDir: gitignoredNonServedAfterpackDir,
        fileName: `${bundleLegIdentity}.protectionMap.html`,
      },
      buildLeg: bundleLegIdentity,
      artifactOptions: {
        ...config.options.artifactOptions,
        build: {
          ...config.options.artifactOptions.build,
          mode: options.mode === "production" ? "production" : "development",
        },
      },
      hasBundlerSourcemap: Boolean(bundle.env.sourceMap),
      env: seedEnvCopy,
      logger: {
        warn: (message) => logger.warn({ message: escapeParcelMarkdown(message) }),
        log: (message) => logger.info({ message: escapeParcelMarkdown(message) }),
      },
      seed: config.options.seed,
      preset: config.options.preset,
      complexity: config.options.complexity,
      regions: config.options.regions,
      engineConfig: config.engineConfig,
      diagnostics: config.options.diagnostics?.level,
      directivesEnabled: config.options.directives.enabled,
      directivesEnabledExplicit: config.options.directives.explicit,
      postMinify: true,
      messages: {
        autoEnableBundlerSourcemap:
          "protectionMap:true but this bundle carried no source map; enable source maps on the " +
          "Parcel target so future builds can render original source in the map.",
        directivesNeedClientMaps:
          "`directives.enabled` is true but this bundle carried no source map with `sourcesContent`; enable " +
          "source maps on the Parcel target so `/* @afterpack ... */` directives can be recovered. " +
          "No directive was applied to this bundle.",
      },
    });

    const out = result.outputs?.[0];
    if (!out) {
      throw new ThrowableDiagnostic({
        diagnostic: {
          message: `AfterPack returned no output for bundle ${bundle.displayName}.`,
          origin: PLUGIN_NAME,
        },
      });
    }

    const lost = hashRefs.filter((ref) => !out.code.includes(ref));
    if (lost.length > 0) {
      throw new ThrowableDiagnostic({
        diagnostic: {
          message:
            `AfterPack obfuscated ${lost.length} Parcel content-hash placeholder(s) in ` +
            `${bundle.displayName} (${lost.join(", ")}). Parcel replaces those tokens by a raw ` +
            "byte scan after every optimizer, so shipping this bundle would break every URL " +
            "built from them.",
          origin: PLUGIN_NAME,
          hints: [
            "Run `parcel build --no-content-hash` (chunk URLs stop being content-addressed).",
            'Or set `"preset": "minify"` in afterpack.json to ship minify-only.',
          ],
        },
      });
    }

    let outCode = out.code;
    let originalRelativeSourceMap: InstanceType<typeof SourceMap> | null = null;
    if (result.policy.sourceMap && out.sourceMap != null) {
      originalRelativeSourceMap = new SourceMap(options.projectRoot);
      originalRelativeSourceMap.addVLQMap(JSON.parse(out.sourceMap));
      if (result.policy.emitSourceMappingURL) {
        const reference = await getSourceMapReference(originalRelativeSourceMap);
        if (reference) outCode += `\n//# sourceMappingURL=${reference}\n`;
      }
    }

    return { contents: outCode, map: originalRelativeSourceMap };
  },
});
