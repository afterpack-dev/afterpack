import { readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ProtectionMap } from "@afterpack/protection-map";
import {
  DEFAULT_LOGGER,
  type Logger,
  planArtifactWrites,
  warnIfPublicPath,
  writeArtifacts,
  writeCombinedProtectionMap,
} from "./artifacts.js";
import { sha256Hex, stagedPath } from "./atomic-write.js";
import { collectSourceMaps, collectStylesheets } from "./collect.js";
import {
  assertSupportedCore,
  type ClientIdentity,
  clientString,
  coreSupportsSourceType,
  safeVersionString,
  toCloudApiError,
} from "./compat.js";
import {
  AlreadyObfuscatedError,
  collectDiagnostics,
  type DiagnosticsSummary,
  type DiagnosticsVerbosity,
  type EngineDiagnostic,
  formatAlreadyObfuscatedMessage,
  reportDiagnostics,
  resolveDiagnosticsVerbosity,
} from "./diagnostics.js";
import {
  captureDirectiveRegions,
  DIRECTIVE_MARKER,
  renameGlobalsRefusalMessage,
  scanDirectives,
} from "./directives.js";
import { detectGitContext } from "./git.js";
import {
  afterpackHashSalt,
  cloudEngineMismatch,
  readEngineVersion,
  resolveSaltEngine,
  type SaltEngine,
} from "./hash-salt.js";
import {
  type HashedNameInput,
  type HashedNamesOptions,
  type HashedNamesPlan,
  planHashedNames,
} from "./hashed-names.js";
import { afterpackHome, describeUnanchoredHome } from "./home.js";
import { type CapturedModule, colorRegions, type DecodedSourceMap } from "./map-color.js";
import { type CloudNotice, reportNotices, sanitizeServerText } from "./notices.js";
import {
  type AfterpackArtifactOptions,
  type BuildContext,
  buildContext,
  buildEngineConfig,
  type CoreConfig,
  DEFAULT_PRESET,
  type EnvLike,
  type Preset,
  type RegionConfig,
  type ReportPolicy,
  resolveReportPolicy,
} from "./policy.js";
import {
  detectAlreadyObfuscatedInputs,
  type EngineSource,
  prepareProtectionReceipt,
  sweepOutputTree,
  type WriteProtectionReceiptInput,
  writeProtectionReceipt,
} from "./receipt.js";
import type { CoreConfigSubset, SourceType } from "./registry.js";
import {
  type ResolvedBuildSeed,
  resolveBuildSeed,
  type SeedOption,
  type SeedOrigin,
} from "./seed.js";
import {
  bundlerSourceMapPaths,
  containedSourceMaps,
  discoverInputSourceMap,
  removeSourceMaps,
  stripCssSourceMappingURLs,
  withinRealDir,
  withoutCssSourceMappingURL,
  withSourceMappingURL,
} from "./source-map.js";
import { formatPassSummary, type PassSummaryStyle } from "./summary.js";
import {
  resolveTelemetryEnabled,
  type TelemetryFacts,
  type TelemetryReporter,
} from "./telemetry.js";
import { prepareWireBatch, type WireBatch, WirePathError } from "./wire.js";

export interface EngineFileInput {
  path: string;
  source: string;
  sourceMap?: string;
  regions?: RegionConfig[];
}

export interface EngineFileResult {
  path: string;
  code: string;
  sourceMap?: string;
  protectionMap?: ProtectionMap;
  status: "success" | "failure";
  error?: string;
  unobfuscated?: boolean;
  diagnostics?: EngineDiagnostic[];
}

export interface EngineBatchResult {
  files: EngineFileResult[];
  totalFiles: number;
  successCount: number;
  failureCount: number;
  source: "local" | "cloud";
  notices?: CloudNotice[];
  engineVersion?: string;
}

export interface ObfuscationEngine {
  processBatch(
    inputs: EngineFileInput[],
    config: CoreConfig,
    buildContext?: BuildContext | null,
  ): Promise<EngineBatchResult>;
  version?(): Promise<string>;
}

export interface CombinedProtectionMapTarget {
  buildDir: string;
  fileTarget?: boolean;
  subdir?: string;
  fileName?: string;
}

export interface InMemoryInput {
  source: string;
  sourceMap?: string | null;
}

export interface InMemoryOutput {
  path: string;
  code: string;
  sourceMap: string | null;
}

export interface PassMessages {
  autoEnableBundlerSourcemap?: string;
  directivesNeedClientMaps?: string;
}

export interface PassReceiptIdentity {
  bundler?: string;
  buildId?: string | null;
}

export interface PassWritePlan {
  renamed: ReadonlyMap<string, string>;
  planned: ReadonlyMap<string, readonly (string | null)[]>;
}

export interface ObfuscationPassOptions {
  files: string[];
  inputs?: Map<string, InMemoryInput>;
  emitToCaller?: boolean;
  engine: ObfuscationEngine;
  label: string;
  cwd: string;
  combinedProtectionMap: CombinedProtectionMapTarget;
  artifactOptions?: AfterpackArtifactOptions;
  hasBundlerSourcemap?: boolean;
  seed?: SeedOption;
  buildLeg?: string;
  preset?: Preset;
  complexity?: number;
  sourceType?: SourceType;
  regions?: RegionConfig[];
  engineConfig?: CoreConfigSubset;
  directivesEnabled?: boolean;
  postMinify?: boolean;
  directivesEnabledExplicit?: boolean;
  capturedByFile?: Map<string, CapturedModule[]>;
  env?: EnvLike;
  messages?: PassMessages;
  receipt?: PassReceiptIdentity;
  afterWrite?: (writtenFiles: string[]) => void;
  beforeWrite?: (plan: PassWritePlan) => void;
  resolvedSeed?: ResolvedBuildSeed;
  hashedNames?: HashedNamesOptions;
  cloudEngineExpectation?: SaltEngine;
  sourceMapSweepDir?: string | null;
  outputSweep?: boolean;
  diagnostics?: DiagnosticsVerbosity;
  telemetry?: TelemetryReporter;
  clientVersion?: string;
  client?: ClientIdentity | null;
  logger?: Logger;
  startedAt?: number;
  summaryStyle?: PassSummaryStyle;
  colorGlyph?: (glyph: string) => string;
  onBatch?: (inputs: readonly EngineFileInput[], batch: EngineBatchResult) => void;
}

export interface PassTiming {
  totalMs: number;
  prepMs: number;
  engineMs: number;
  writeMs: number;
  cloudMs: number | null;
  engineSource: string | null;
  callerAnchored: boolean;
}

export interface ObfuscationPassResult {
  fileCount: number;
  protectionMapPath: string | null;
  receiptPath: string | null;
  deferredReceipt: WriteProtectionReceiptInput | null;
  policy: ReportPolicy;
  seed: number | string;
  seedOrigin: SeedOrigin;
  timing: PassTiming;
  diagnostics: DiagnosticsSummary;
  transformedFiles: string[];
  renamed: Map<string, string>;
  hashSalt: string | null;
  outputs?: InMemoryOutput[];
}

function silenceSummaryLines(logger: Logger, level: DiagnosticsVerbosity | undefined): Logger {
  if (level !== "none") return logger;
  return { warn: (m) => logger.warn(m), log: () => {} };
}

function parseSourceMap(json: string | null | undefined): DecodedSourceMap | null {
  if (!json) return null;
  try {
    const m = JSON.parse(json) as {
      sources?: (string | null)[];
      mappings?: string;
      sourcesContent?: (string | null)[];
    };
    if (typeof m.mappings !== "string") return null;
    return {
      sources: m.sources ?? [],
      mappings: m.mappings,
      sourcesContent: Array.isArray(m.sourcesContent) ? m.sourcesContent : undefined,
    };
  } catch {
    return null;
  }
}

function fileFailure(f: EngineFileResult, source: string): string | null {
  if (f.status !== "success") {
    const reason = sanitizeServerText(f.error);
    if (reason) return reason;
    return f.status === "failure"
      ? "empty output"
      : `the engine reported status "${sanitizeServerText(f.status, 32)}"`;
  }
  if (f.unobfuscated === true) {
    return "the engine could not obfuscate it and returned the original source — update @afterpack/core";
  }
  if (f.code === "" && source.trim() !== "") return sanitizeServerText(f.error) || "empty output";
  return null;
}

function bundlerMapsToRemove(input: {
  perFile: Iterable<string[]>;
  sweepDir: string | null;
  engineMaps: Set<string>;
  policy: ReportPolicy;
}): string[] {
  const { sweepDir, engineMaps, policy } = input;
  const bundlerMaps = new Set<string>([...input.perFile].flat());
  if (sweepDir != null) {
    const swept = collectSourceMaps(sweepDir).filter(
      (path) => !policy.sourceMap || !path.endsWith(".css.map"),
    );
    for (const path of containedSourceMaps(swept, sweepDir)) bundlerMaps.add(path);
  }
  return [...bundlerMaps].filter((path) => !engineMaps.has(path));
}

function removeBundlerSourceMaps(input: {
  perFile: Iterable<string[]>;
  sweepDir: string | null;
  engineMaps: Set<string>;
  policy: ReportPolicy;
  label: string;
}): void {
  const { sweepDir, policy, label } = input;
  removeSourceMaps(bundlerMapsToRemove(input), label);
  if (sweepDir != null && !policy.sourceMap) {
    stripCssSourceMappingURLs(collectStylesheets(sweepDir));
  }
}

function describeLevel(preset: Preset | undefined, complexity: number | undefined): string {
  if (complexity === undefined) return `preset "${preset ?? DEFAULT_PRESET}"`;
  if (preset === undefined) return `complexity target ${complexity}`;
  return `preset "${preset}" with complexity target ${complexity}`;
}

export async function runObfuscationPass(
  options: ObfuscationPassOptions,
): Promise<ObfuscationPassResult> {
  const passStartedAt = options.startedAt ?? Date.now();
  const callerAnchored = options.startedAt !== undefined;
  const {
    engine,
    label,
    cwd,
    combinedProtectionMap,
    artifactOptions = {},
    env = process.env,
  } = options;
  const logger = silenceSummaryLines(options.logger ?? DEFAULT_LOGGER, options.diagnostics);
  const prefix = (message: string): string => `[${label}] ${message}`;
  const style: PassSummaryStyle = options.summaryStyle ?? "plugin";
  assertSupportedCore(options.client, prefix);

  const outsideBuildDir = options.emitToCaller
    ? []
    : options.files.filter(
        (f) =>
          !options.inputs?.has(f) && !withinRealDir(dirname(f), combinedProtectionMap.buildDir),
      );
  const files = options.files.filter((f) => !outsideBuildDir.includes(f));
  if (outsideBuildDir.length > 0) {
    logger.warn(
      prefix(
        `left ${outsideBuildDir.length} file(s) untouched because a symlink places them outside ` +
          `${combinedProtectionMap.buildDir}: ${outsideBuildDir.join(", ")}`,
      ),
    );
  }

  const onDiskFiles = options.inputs ? files.filter((f) => !options.inputs?.has(f)) : files;
  const onDiskBytes = new Map<string, Buffer>(
    await Promise.all(
      onDiskFiles.map(async (filePath) => [filePath, await readFile(filePath)] as const),
    ),
  );

  const home = afterpackHome(combinedProtectionMap.buildDir, {
    fileTarget: combinedProtectionMap.fileTarget,
  });
  const unanchored = describeUnanchoredHome(home);
  if (unanchored) logger.log(prefix(unanchored));
  if (!options.emitToCaller) {
    const already = detectAlreadyObfuscatedInputs(onDiskFiles, home, onDiskBytes, prefix);
    if (already) {
      throw new AlreadyObfuscatedError(
        prefix(
          formatAlreadyObfuscatedMessage({
            files: already.files,
            receiptPath: already.receiptPath,
            dir: combinedProtectionMap.buildDir,
          }),
        ),
        already.files,
        already.receiptPath,
        combinedProtectionMap.buildDir,
      );
    }
  }

  if (options.outputSweep !== false) {
    sweepOutputTree(
      combinedProtectionMap.buildDir,
      options.sourceMapSweepDir ?? (options.emitToCaller ? combinedProtectionMap.buildDir : null),
      label,
      home,
    );
  }
  prepareProtectionReceipt(home, label);

  const resolvedSeed =
    options.resolvedSeed ??
    resolveBuildSeed(
      options.seed,
      { root: cwd, leg: options.buildLeg ?? combinedProtectionMap.buildDir },
      { env, warn: (m) => logger.warn(m) },
    );
  const seed = resolvedSeed.seed;
  if (resolvedSeed.mismatch) {
    logger.warn(
      prefix(
        `build seed ${seed} does not match leg "${resolvedSeed.mismatch.leg}" of this same ` +
          `build, which used ${resolvedSeed.mismatch.seed} — pin the same \`seed\` on every ` +
          "leg (or none) so the bundles share one polymorphic layout.",
      ),
    );
  }

  const directivesEnabled = options.directivesEnabled ?? false;
  const bundledCapture = options.capturedByFile != null;
  const postMinifyMode = directivesEnabled && options.postMinify === true && !bundledCapture;

  const sourceByPath = new Map<string, string>();
  const bundlerMapsByPath = new Map<string, string[]>();
  const sweepDir = options.sourceMapSweepDir ?? null;
  const sourceMapRoot = sweepDir ?? combinedProtectionMap.buildDir;
  let coloredRegionCount = 0;
  let directivesNeededMap = false;
  let postMinifyMapsSeen = 0;
  const postMinifyDiagnostics: string[] = [];
  const postMinifyRenameGlobals: string[] = [];
  const inputs: EngineFileInput[] = files.map((filePath) => {
    const provided = options.inputs?.get(filePath);
    const source = provided
      ? provided.source
      : (onDiskBytes.get(filePath) ?? readFileSync(filePath)).toString("utf8");
    sourceByPath.set(filePath, source);
    if (!provided && !options.emitToCaller) {
      bundlerMapsByPath.set(filePath, bundlerSourceMapPaths(filePath, source, sourceMapRoot));
    }
    const inputSourceMap = provided
      ? (provided.sourceMap ?? null)
      : discoverInputSourceMap(filePath, source);
    let regions: RegionConfig[] | undefined;
    const modules = options.capturedByFile?.get(filePath);
    if (modules?.some((m) => m.directives.length > 0)) {
      const map = parseSourceMap(inputSourceMap);
      if (!map) {
        directivesNeededMap = true;
      } else {
        const colored = colorRegions(source, map, modules, (m) => logger.warn(prefix(m)));
        if (colored.length > 0) {
          regions = colored;
          coloredRegionCount += colored.length;
        }
      }
    } else if (postMinifyMode) {
      const map = parseSourceMap(inputSourceMap);
      if (map?.sourcesContent && map.sourcesContent.length > 0) {
        postMinifyMapsSeen += 1;
        const mods: CapturedModule[] = [];
        for (let i = 0; i < map.sourcesContent.length; i++) {
          const content = map.sourcesContent[i];
          const id = map.sources[i];
          if (!content || id == null || !content.includes(DIRECTIVE_MARKER)) continue;
          const scan = scanDirectives(content);
          for (const d of scan.diagnostics) {
            postMinifyDiagnostics.push(`${id} (${d.line}:${d.column}): ${d.message}`);
          }
          if (scan.renameGlobals) postMinifyRenameGlobals.push(`${id} (bundled into ${filePath})`);
          if (scan.directives.length > 0) {
            mods.push({ id, source: content, directives: scan.directives, srcIndex: i });
          }
        }
        if (mods.length > 0) {
          const colored = colorRegions(source, map, mods, (m) => logger.warn(prefix(m)));
          if (colored.length > 0) {
            regions = colored;
            coloredRegionCount += colored.length;
          }
        }
      }
    }
    return { path: filePath, source, sourceMap: inputSourceMap ?? undefined, regions };
  });
  onDiskBytes.clear();

  const hasBundlerSourcemap =
    (options.hasBundlerSourcemap ?? false) || inputs.some((i) => i.sourceMap != null);
  const policy = resolveReportPolicy(env, artifactOptions, {
    hasBundlerSourcemap,
    inPlaceOutput: true,
  });
  if (policy.autoEnableBundlerSourcemap && options.messages?.autoEnableBundlerSourcemap) {
    logger.warn(prefix(options.messages.autoEnableBundlerSourcemap));
  }
  if (options.emitToCaller && artifactOptions.build?.backup === true) {
    logger.warn(
      prefix(
        "build.backup:true is not available on this build — the obfuscated output is handed back in " +
          "memory, so there is no emitted file for a `.backup.<hash>` copy to sit beside.",
      ),
    );
  }

  const capture = captureDirectiveRegions(
    inputs,
    options.regions,
    directivesEnabled && !bundledCapture && !(postMinifyMode && inputs.length > 1),
  );
  for (const d of capture.diagnostics) {
    logger.warn(prefix(`directive at ${d.line}:${d.column}: ${d.message}`));
  }
  for (const d of postMinifyDiagnostics) {
    logger.warn(prefix(`directive in ${d}`));
  }
  const bundledRenameGlobals: string[] = [];
  if (bundledCapture && directivesEnabled) {
    for (const [file, modules] of options.capturedByFile ?? []) {
      for (const mod of modules) {
        if (mod.renameGlobals) bundledRenameGlobals.push(`${mod.id} (bundled into ${file})`);
      }
    }
  }
  const renameGlobalsRefused = [
    ...capture.renameGlobalsRefused,
    ...postMinifyRenameGlobals,
    ...bundledRenameGlobals,
  ];
  if (renameGlobalsRefused.length > 0) {
    logger.warn(prefix(renameGlobalsRefusalMessage(renameGlobalsRefused, files.length)));
  }
  if (capture.deferredFiles > 0) {
    logger.warn(
      prefix(
        `found @afterpack directives in ${capture.deferredFiles} file(s) but this is a ` +
          "multi-file build; enable the bundler's directive capture (backward-coloring) to apply them.",
      ),
    );
  }
  if (coloredRegionCount > 0) {
    logger.log(prefix(`applied ${coloredRegionCount} directive region(s) across the bundle`));
  }
  if (directivesNeededMap) {
    logger.warn(
      prefix(
        "found @afterpack directives in a bundled file with no source map — skipped them " +
          "(enable the bundler's sourcemap so they can be colored into the emitted output).",
      ),
    );
  }
  if (
    postMinifyMode &&
    options.directivesEnabledExplicit === true &&
    files.length > 0 &&
    postMinifyMapsSeen === 0 &&
    options.messages?.directivesNeedClientMaps
  ) {
    logger.warn(prefix(options.messages.directivesNeedClientMaps));
  }
  const mappedInputs = inputs.filter((i) => i.sourceMap != null).length;
  if (policy.protectionMap && files.length > 0 && mappedInputs > 0 && mappedInputs < files.length) {
    logger.warn(
      prefix(
        `source-map coverage: ${mappedInputs}/${files.length} chunk(s) had a discoverable input ` +
          `source map — the other ${files.length - mappedInputs} are attributed only as opaque dist ` +
          "chunks, so the Protection Map under-reports their original sources.",
      ),
    );
  }

  const git =
    artifactOptions.git === false
      ? null
      : detectGitContext(artifactOptions.git ?? null, { env, cwd });

  const localEngineVersion = await readEngineVersion(engine);
  const derivedSourceType =
    options.sourceType !== undefined &&
    coreSupportsSourceType(localEngineVersion ?? options.client?.coreVersion)
      ? options.sourceType
      : undefined;
  const engineConfig = buildEngineConfig({
    policy,
    seed,
    preset: options.preset,
    complexity: options.complexity,
    sourceType: derivedSourceType,
    regions: capture.regions,
    engine: options.engineConfig,
    renameGlobals: capture.renameGlobals,
  });
  const saltEngine: SaltEngine | null =
    options.cloudEngineExpectation ??
    (options.hashedNames ? await resolveSaltEngine(env, localEngineVersion) : null);
  let namesPlan: HashedNamesPlan | null = null;
  let hashSalt: string | null = null;
  if (options.hashedNames && saltEngine && !options.emitToCaller) {
    const { seed: _seed, ...configWithoutSeed } = engineConfig;
    const namedInputs = new Map<string, HashedNameInput>(
      inputs.map((input) => [input.path, { source: input.source, regions: input.regions }]),
    );
    hashSalt = afterpackHashSalt({
      seed,
      engine: saltEngine,
      settings: {
        engine: configWithoutSeed,
        sourceMap: policy.sourceMap,
        emitSourceMappingURL: policy.emitSourceMappingURL,
      },
    });
    namesPlan = planHashedNames({
      options: options.hashedNames,
      inputs: namedInputs,
      salt: hashSalt,
    });
    namesPlan.preflight();
    for (const input of inputs) {
      const path = namesPlan.renamed.get(input.path) ?? input.path;
      const source = namesPlan.rewrite(input.source);
      sourceByPath.delete(input.path);
      sourceByPath.set(path, source);
      input.path = path;
      input.source = source;
    }
  }
  if (style !== "cli") {
    logger.log(
      prefix(
        `obfuscating ${inputs.length} file(s) at ${describeLevel(options.preset, options.complexity)} ...`,
      ),
    );
  }
  const engineStartedAt = Date.now();
  const prepMs = engineStartedAt - passStartedAt;
  const context = buildContext(git, {
    clientVersion: options.client?.coreVersion,
    client: clientString(options.client),
  });
  let wire: WireBatch;
  try {
    wire = prepareWireBatch(inputs, engineConfig, combinedProtectionMap.buildDir, home.projectRoot);
  } catch (error) {
    if (error instanceof WirePathError) throw new Error(prefix(error.message));
    throw error;
  }
  let batch: EngineBatchResult;
  try {
    batch = wire.toLocal(await engine.processBatch(wire.inputs, wire.config, context));
  } catch (error) {
    const cloud = toCloudApiError(error, { identity: options.client, prefix });
    if (!cloud) throw error;
    reportNotices(cloud.notices, logger, prefix);
    throw cloud;
  }
  const engineEndedAt = Date.now();
  options.onBatch?.(inputs, batch);
  reportNotices(batch.notices, logger, prefix);
  const engineMs = engineEndedAt - engineStartedAt;

  const collected = collectDiagnostics(batch.files);
  const diagnosticsSummary = reportDiagnostics({
    diagnostics: collected.diagnostics,
    malformedEntries: collected.malformedEntries,
    logger,
    prefix,
    verbosity: resolveDiagnosticsVerbosity(options.diagnostics),
  });
  if (collected.unknownFiles > 0 && batch.source === "cloud") {
    logger.warn(
      prefix(
        "engine diagnostics are not returned on the Pro Cloud path — this build's " +
          "diagnostics were recorded server-side.",
      ),
    );
  }

  const telemetry = options.telemetry;
  const telemetryEnabled =
    telemetry != null && resolveTelemetryEnabled(artifactOptions.telemetry?.enabled, env);
  const engineVersion =
    (batch.source === "cloud" ? safeVersionString(batch.engineVersion) : null) ??
    localEngineVersion;
  if (saltEngine) {
    const mismatch = cloudEngineMismatch(
      saltEngine,
      batch.source === "cloud" ? safeVersionString(batch.engineVersion) : null,
    );
    if (mismatch) throw new Error(prefix(mismatch));
  }
  if (telemetry && telemetryEnabled) {
    const facts: TelemetryFacts = {
      label,
      projectRoot: cwd,
      diagnostics: collected.diagnostics,
      fileCount: files.length,
      durationMs: engineEndedAt - passStartedAt,
      preset: options.preset,
      complexity: options.complexity,
      engineVersion,
      clientVersion: options.clientVersion ?? options.client?.packageVersion ?? null,
    };
    await telemetry(facts);
  }

  const protectionMapDocs: ProtectionMap[] = [];
  const sensitiveArtifactPaths: string[] = [];
  const outputs: InMemoryOutput[] = [];
  let inputBytes = 0;
  let outputBytes = 0;
  let noOp = 0;
  const transformedFiles: string[] = [];
  const verified: { result: EngineFileResult; source: string }[] = [];
  for (const f of batch.files) {
    const source = sourceByPath.get(f.path);
    if (source === undefined) {
      throw new Error(prefix(`no captured source for engine-returned path ${f.path}`));
    }
    const failure = fileFailure(f, source);
    if (failure !== null) {
      throw new Error(prefix(`failed to obfuscate ${f.path}: ${failure}`));
    }

    inputBytes += Buffer.byteLength(source);
    outputBytes += Buffer.byteLength(f.code);
    if (f.code === source) noOp += 1;
    else transformedFiles.push(f.path);

    if (policy.protectionMap && f.protectionMap != null) {
      protectionMapDocs.push(f.protectionMap);
    }
    verified.push({ result: f, source });
  }

  const artifactInput = (f: EngineFileResult, source: string) => ({
    outPath: f.path,
    code: withSourceMappingURL(f.code, null),
    sourceMapJson: f.sourceMap ?? null,
    originalSource: source,
    policy,
    mode: "framework" as const,
  });

  if (!options.emitToCaller && options.beforeWrite) {
    const planned = new Map<string, (string | null)[]>();
    const expectState = (path: string, state: string | null): void => {
      const states = planned.get(path) ?? [];
      if (!states.includes(state)) states.push(state);
      planned.set(path, states);
    };
    for (const from of namesPlan?.renamed.keys() ?? []) expectState(from, null);
    const plannedEngineMaps = new Set<string>();
    for (const { result: f, source } of verified) {
      const artifacts = planArtifactWrites(artifactInput(f, source));
      if (artifacts.mapPath) plannedEngineMaps.add(resolve(artifacts.mapPath));
      for (const write of artifacts.writes) {
        expectState(write.path, sha256Hex(write.content));
        expectState(stagedPath(write.path), null);
      }
    }
    for (const { to, text } of namesPlan?.rewrites.values() ?? []) {
      expectState(to, sha256Hex(text));
      expectState(stagedPath(to), null);
    }
    for (const map of bundlerMapsToRemove({
      perFile: bundlerMapsByPath.values(),
      sweepDir,
      engineMaps: plannedEngineMaps,
      policy,
    })) {
      expectState(map, null);
    }
    if (sweepDir != null && !policy.sourceMap) {
      for (const css of collectStylesheets(sweepDir)) {
        const rewritten = namesPlan?.rewrites.get(css);
        const text = rewritten?.text ?? readFileSync(css, "utf8");
        const stripped = withoutCssSourceMappingURL(text);
        if (stripped === text) continue;
        expectState(rewritten?.to ?? css, sha256Hex(stripped));
        expectState(stagedPath(rewritten?.to ?? css), null);
      }
    }
    options.beforeWrite({ renamed: namesPlan?.renamed ?? new Map(), planned });
  }

  const writtenFiles: string[] = [];
  const emittedFiles: string[] = [];
  const engineMaps = new Set<string>();
  for (const { result: f, source } of verified) {
    if (options.emitToCaller) {
      outputs.push({ path: f.path, code: f.code, sourceMap: f.sourceMap ?? null });
      emittedFiles.push(f.path);
      continue;
    }
    const written = writeArtifacts({
      ...artifactInput(f, source),
      protectionMapJson: null,
      afterpackDir: home.dir,
      logger,
    });
    writtenFiles.push(written.codePath);
    if (written.mapPath) {
      sensitiveArtifactPaths.push(written.mapPath);
      engineMaps.add(resolve(written.mapPath));
    }
    if (written.backupPath) sensitiveArtifactPaths.push(written.backupPath);
  }
  if (!options.emitToCaller) {
    if (namesPlan) {
      for (const [from, to] of namesPlan.renamed) {
        if (sourceByPath.has(to)) rmSync(from, { force: true });
      }
      namesPlan.apply();
      if (namesPlan.renamed.size > 0) {
        logger.log(
          prefix(
            `renamed ${namesPlan.renamed.size} content-hashed file(s) so each name follows its ` +
              "obfuscated bytes",
          ),
        );
      }
    }
    removeBundlerSourceMaps({
      perFile: bundlerMapsByPath.values(),
      sweepDir,
      engineMaps,
      policy,
      label,
    });
    options.afterWrite?.(writtenFiles);
  }

  const protectionMapPath = writeCombinedProtectionMap({
    buildDir: combinedProtectionMap.buildDir,
    docs: protectionMapDocs,
    policy,
    afterpackDir: combinedProtectionMap.subdir
      ? join(home.dir, combinedProtectionMap.subdir)
      : home.dir,
    fileName: combinedProtectionMap.fileName,
    logger,
  });
  if (protectionMapPath) sensitiveArtifactPaths.push(protectionMapPath);

  for (const artifactPath of sensitiveArtifactPaths) {
    if (warnIfPublicPath(artifactPath, logger)) break;
  }

  let receiptPath: string | null = null;
  let deferredReceipt: WriteProtectionReceiptInput | null = null;
  const engineSource: EngineSource | null =
    batch.source === "local" || batch.source === "cloud" ? batch.source : null;
  const receiptFields = {
    tool: label,
    engine: engineSource,
    engineVersion,
    seed,
    seedOrigin: resolvedSeed.origin,
    bundler: options.receipt?.bundler ?? "unknown",
    buildId: options.receipt?.buildId ?? null,
    transformed: transformedFiles,
  };
  if (options.emitToCaller) {
    deferredReceipt = {
      ...receiptFields,
      dir: combinedProtectionMap.buildDir,
      home,
      files: emittedFiles,
    };
  } else {
    receiptPath = writeProtectionReceipt({
      ...receiptFields,
      dir: combinedProtectionMap.buildDir,
      home,
      merge: combinedProtectionMap.fileTarget === true,
      files: writtenFiles,
    });
    if (style !== "cli") {
      logger.log(prefix(`wrote protection receipt -> ${receiptPath} (afterpack verify)`));
    }
  }

  const writeEndedAt = Date.now();
  const writeMs = writeEndedAt - engineEndedAt;
  const totalMs = writeEndedAt - passStartedAt;
  const cloudMs = engineSource === "cloud" ? engineMs : null;
  const timing: PassTiming = {
    totalMs,
    prepMs,
    engineMs,
    writeMs,
    cloudMs,
    engineSource,
    callerAnchored,
  };

  const summaryVerbosity = resolveDiagnosticsVerbosity(options.diagnostics);
  const seedSuffix =
    summaryVerbosity === "all"
      ? ` · seed ${seed} (${resolvedSeed.mismatch ? "MISMATCH" : resolvedSeed.origin})`
      : "";
  logger.log(
    formatPassSummary(
      {
        label,
        fileCount: files.length,
        inputBytes,
        outputBytes,
        noOpCount: noOp,
        elapsedMs: totalMs,
      },
      style,
      options.colorGlyph,
    ) + seedSuffix,
  );

  return {
    fileCount: files.length,
    protectionMapPath,
    receiptPath,
    deferredReceipt,
    policy,
    seed,
    seedOrigin: resolvedSeed.origin,
    timing,
    diagnostics: diagnosticsSummary,
    transformedFiles,
    renamed: namesPlan?.renamed ?? new Map(),
    hashSalt,
    ...(options.emitToCaller ? { outputs } : {}),
  };
}
