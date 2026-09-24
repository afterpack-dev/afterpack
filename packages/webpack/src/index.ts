import { readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { processBatch, version } from "@afterpack/core";
import {
  type AfterpackArtifactOptions,
  type AfterpackPluginOptions,
  type CapturedModule,
  type CoreConfigSubset,
  createTelemetryReporter,
  decodeDataUri,
  extractSourceMappingURL,
  type InMemoryInput,
  type PluginOptionsView,
  resolveClientIdentity,
  resolvePluginConfig,
  runObfuscationPass,
  scanDirectives,
  type WriteProtectionReceiptInput,
  withSourceMappingURL,
  writeDeferredProtectionReceipt,
} from "@afterpack/integration-utils";
import type { Compilation, Compiler } from "webpack";

const PLUGIN_NAME = "AfterpackWebpackPlugin";
const EMITTED_JS_RE = /\.(?:js|mjs|cjs)$/;
const SOURCE_MODULE_RE = /\.(?:m?[jt]sx?)$/;

const PATHS_INCLUDE_UNSUPPORTED =
  "this plugin obfuscates the assets webpack's own chunks claim, in the pipeline — there is no " +
  "output-directory walk for a glob to re-admit anything into. Use `npx afterpack <dir> " +
  "--paths.include=...` for a disk walk, or drop the key.";

export type AfterpackWebpackOptions = AfterpackPluginOptions;

interface CapturedSource extends CapturedModule {
  renameGlobals: boolean;
}

interface OwnedAsset {
  name: string;
  mapName: string | null;
  url: string | null;
}

function isEmittedJs(name: string): boolean {
  return !name.includes(".hot-update.") && EMITTED_JS_RE.test(name);
}

function assetText(compilation: Compilation, name: string): string | null {
  const asset = compilation.getAsset(name);
  if (!asset) return null;
  const value = asset.source.source();
  return typeof value === "string" ? value : value.toString("utf8");
}

function inputSourceMap(compilation: Compilation, asset: OwnedAsset): string | null {
  if (asset.mapName) return assetText(compilation, asset.mapName);
  if (asset.url == null) return null;
  if (asset.url.startsWith("data:")) return decodeDataUri(asset.url);
  if (/^https?:\/\//i.test(asset.url) || asset.url.startsWith("//")) return null;
  const dir = asset.name.includes("/") ? `${asset.name.replace(/\/[^/]*$/, "")}/` : "";
  return assetText(compilation, `${dir}${asset.url}`.replace(/^\.\//, ""));
}

function chunkClaimedJsAssets(compilation: Compilation): OwnedAsset[] {
  const names = new Set<string>();
  for (const chunk of compilation.chunks) {
    for (const name of chunk.files) {
      if (isEmittedJs(name)) names.add(name);
    }
  }
  const out: OwnedAsset[] = [];
  for (const name of names) {
    const asset = compilation.getAsset(name);
    if (!asset) continue;
    const related = (asset.info as { related?: { sourceMap?: string | string[] } }).related;
    const sourceMap = related?.sourceMap;
    const mapName = typeof sourceMap === "string" ? sourceMap : (sourceMap?.[0] ?? null);
    const text = assetText(compilation, name);
    out.push({ name, mapName, url: text ? extractSourceMappingURL(text) : null });
  }
  return out;
}

function collectResourcesThroughConcatenatedModules(module: unknown, out: string[]): void {
  if (module == null || typeof module !== "object") return;
  const inner = (module as { modules?: unknown }).modules;
  if (Array.isArray(inner)) {
    for (const m of inner) collectResourcesThroughConcatenatedModules(m, out);
    return;
  }
  const resource = (module as { resource?: unknown }).resource;
  if (typeof resource === "string") out.push(resource.replace(/[?#].*$/, ""));
}

export class AfterpackWebpackPlugin {
  private readonly settings: PluginOptionsView;
  private readonly artifactOptions: AfterpackArtifactOptions;
  private readonly engineConfig: CoreConfigSubset;
  private readonly captured = new Map<string, CapturedSource>();
  private readonly seenByBuildHooksThisCompilation = new Set<string>();
  private readonly captureDiagnostics: string[] = [];
  private readonly deferredReceiptByCompilation = new WeakMap<
    Compilation,
    WriteProtectionReceiptInput
  >();

  constructor(options: AfterpackWebpackOptions = {}) {
    const resolved = resolvePluginConfig({
      label: PLUGIN_NAME,
      options,
      unsupported: { "paths.include": PATHS_INCLUDE_UNSUPPORTED },
    });
    this.settings = resolved.options;
    this.artifactOptions = resolved.options.artifactOptions;
    this.engineConfig = resolved.engineConfig;
  }

  apply(compiler: Compiler): void {
    const context = compiler.options.context ?? process.cwd();
    const directivesEnabled = this.settings.directives;
    if (directivesEnabled) {
      compiler.hooks.thisCompilation.tap(PLUGIN_NAME, () => {
        this.seenByBuildHooksThisCompilation.clear();
      });
    }

    compiler.hooks.compilation.tap(PLUGIN_NAME, (compilation) => {
      if (directivesEnabled) {
        const hooks = compiler.webpack.NormalModule.getCompilationHooks(compilation);
        hooks.beforeLoaders.tap(PLUGIN_NAME, (_loaders, module) => {
          this.capture(module.resource, context);
        });
      }
      compilation.hooks.processAssets.tapPromise(
        { name: PLUGIN_NAME, stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_REPORT },
        () => this.obfuscate(compiler, compilation, context),
      );
    });

    compiler.hooks.afterEmit.tapPromise(PLUGIN_NAME, async (compilation) => {
      const deferred = this.deferredReceiptByCompilation.get(compilation);
      if (!deferred) return;
      this.deferredReceiptByCompilation.delete(compilation);
      try {
        const receiptPath = writeDeferredProtectionReceipt(deferred);
        if (receiptPath && this.settings.diagnostics?.level !== "none") {
          console.log(
            `[afterpack-webpack] wrote protection receipt -> ${receiptPath} (afterpack verify)`,
          );
        }
      } catch (error) {
        console.warn(
          `[afterpack-webpack] failed to write protection receipt: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }

  private async obfuscate(
    compiler: Compiler,
    compilation: Compilation,
    context: string,
  ): Promise<void> {
    if (this.settings.build?.autorun === false) return;

    const startedAt = Date.now();
    const outputPath = compiler.outputPath;
    const owned = chunkClaimedJsAssets(compilation);
    if (owned.length === 0) return;

    const byPath = new Map<string, OwnedAsset>();
    const inputs = new Map<string, InMemoryInput>();
    for (const asset of owned) {
      const source = assetText(compilation, asset.name);
      if (source == null) continue;
      const filePath = join(outputPath, asset.name);
      byPath.set(filePath, asset);
      inputs.set(filePath, { source, inputSourceMap: inputSourceMap(compilation, asset) });
    }
    const files = [...byPath.keys()];
    if (files.length === 0) return;

    const directivesEnabled = this.settings.directives;
    const capturedByFile = directivesEnabled
      ? this.joinCaptured(compilation, outputPath, new Set(files), context)
      : new Map<string, CapturedModule[]>();
    for (const message of this.captureDiagnostics) {
      console.warn(`[afterpack-webpack] directive ${message}`);
    }
    this.captureDiagnostics.length = 0;

    const devtool = compiler.options.devtool;
    const result = await runObfuscationPass({
      files,
      inputs,
      emitToCaller: true,
      engine: { processBatch, version },
      client: resolveClientIdentity(import.meta.url),
      telemetry: createTelemetryReporter(),
      label: "afterpack-webpack",
      gitignoreDir: context,
      startedAt,
      capturedByFile: capturedByFile.size > 0 ? capturedByFile : undefined,
      combinedProtectionMap: {
        buildDir: outputPath,
        afterpackDir: join(context, ".afterpack"),
      },
      artifactOptions: this.artifactOptions,
      hasBundlerSourcemap: typeof devtool === "string" && devtool.includes("source-map"),
      seed: this.settings.seed,
      preset: this.settings.preset,
      complexity: this.settings.complexity,
      regions: this.settings.regions,
      engineConfig: this.engineConfig,
      diagnostics: this.settings.diagnostics?.level,
      directives: directivesEnabled,
      directivesExplicit: this.settings.directivesExplicit,
      messages: {
        autoEnableBundlerSourcemap:
          "protectionMap:true but no bundler sourcemap was found; set `devtool: 'source-map'` " +
          "so future builds can render original source in the map.",
      },
    });

    const { RawSource } = compiler.webpack.sources;
    for (const out of result.outputs ?? []) {
      const asset = byPath.get(out.filePath);
      if (!asset) continue;
      const emitMap = result.policy.sourceMap && out.sourceMap != null;
      const mapName = asset.mapName ?? `${asset.name}.map`;
      const keepWebpacksOwnReference = asset.mapName != null;
      const url =
        emitMap && result.policy.emitSourceMappingURL
          ? keepWebpacksOwnReference
            ? asset.url
            : basename(mapName)
          : null;
      compilation.updateAsset(asset.name, new RawSource(withSourceMappingURL(out.code, url)));
      if (emitMap && out.sourceMap != null) {
        const map = new RawSource(out.sourceMap);
        if (compilation.getAsset(mapName)) compilation.updateAsset(mapName, map);
        else compilation.emitAsset(mapName, map);
      } else if (asset.mapName && compilation.getAsset(asset.mapName)) {
        compilation.deleteAsset(asset.mapName);
      }
    }
    if (result.deferredReceipt) {
      this.deferredReceiptByCompilation.set(compilation, result.deferredReceipt);
    }
  }

  private capture(resource: string | undefined, context: string): void {
    if (!resource) return;
    const path = resource.replace(/[?#].*$/, "");
    this.seenByBuildHooksThisCompilation.add(path);
    if (path.replace(/\\/g, "/").includes("/node_modules/")) return;
    if (!SOURCE_MODULE_RE.test(path)) return;
    let source: string;
    try {
      source = readFileSync(path, "utf8");
    } catch {
      return;
    }
    if (!source.includes("@afterpack")) {
      this.captured.delete(path);
      return;
    }
    const idAsWrittenInMapSources = `./${relative(context, path).replace(/\\/g, "/")}`;
    const scan = scanDirectives(source);
    if (scan.directives.length > 0 || scan.renameGlobals) {
      this.captured.set(path, {
        id: idAsWrittenInMapSources,
        source,
        directives: scan.directives,
        renameGlobals: scan.renameGlobals,
      });
    } else {
      this.captured.delete(path);
    }
    for (const d of scan.diagnostics) {
      this.captureDiagnostics.push(
        `${idAsWrittenInMapSources} (${d.line}:${d.column}): ${d.message}`,
      );
    }
  }

  private joinCaptured(
    compilation: Compilation,
    outputPath: string,
    emitted: ReadonlySet<string>,
    context: string,
  ): Map<string, CapturedModule[]> {
    const out = new Map<string, CapturedModule[]>();
    const chunkGraph = compilation.chunkGraph;
    if (!chunkGraph) return out;
    const byFile = new Map<string, Map<string, CapturedModule>>();

    for (const chunk of compilation.chunks) {
      const resources: string[] = [];
      for (const module of chunkGraph.getChunkModulesIterable(chunk)) {
        collectResourcesThroughConcatenatedModules(module, resources);
      }
      const mods: CapturedModule[] = [];
      for (const resource of resources) {
        const restoredFromCachePastEveryHook = !this.seenByBuildHooksThisCompilation.has(resource);
        if (restoredFromCachePastEveryHook) this.capture(resource, context);
        const cap = this.captured.get(resource);
        if (cap) mods.push(cap);
      }
      if (mods.length === 0) continue;
      for (const name of chunk.files) {
        if (!isEmittedJs(name)) continue;
        const full = join(outputPath, name);
        if (!emitted.has(full)) continue;
        let bucket = byFile.get(full);
        if (!bucket) {
          bucket = new Map();
          byFile.set(full, bucket);
        }
        for (const mod of mods) bucket.set(mod.id, mod);
      }
    }
    for (const [file, bucket] of byFile) out.set(file, [...bucket.values()]);
    return out;
  }
}
