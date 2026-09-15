import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  DEFAULT_LOGGER,
  ensureGitignore,
  type Logger,
  warnIfPublicPath,
  writeArtifacts,
  writeCombinedProtectionMap,
} from "./artifacts.js";
import {
  collectDiagnostics,
  type DiagnosticsSummary,
  type DiagnosticsVerbosity,
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
import { type CapturedModule, colorRegions, type DecodedSourceMap } from "./map-color.js";
import {
  type AfterpackArtifactOptions,
  buildContextJson,
  buildEngineConfigJson,
  DEFAULT_PRESET,
  type EnvLike,
  type Preset,
  type RegionConfig,
  type ReportPolicy,
  resolveReportPolicy,
} from "./policy.js";
import { detectAlreadyObfuscatedInputs, writeProtectionReceipt } from "./receipt.js";
import type { EngineConfigSubset } from "./registry.js";
import { resolveBuildSeed, type SeedOption, type SeedOrigin } from "./seed.js";
import { discoverInputSourceMap } from "./source-map.js";
import {
  resolveTelemetryEnabled,
  type TelemetryFacts,
  type TelemetryReporter,
} from "./telemetry.js";

export interface EngineFileInput {
  filePath: string;
  source: string;
  inputSourceMap?: string;
  regions?: string;
}

export interface EngineFileResult {
  filePath: string;
  code: string;
  sourceMap?: string;
  protectionMap?: string;
  status: string;
  error?: string;
  unobfuscated?: boolean;
  diagnostics?: string;
}

export interface EngineBatchResult {
  files: EngineFileResult[];
  totalFiles: number;
  successCount: number;
  failureCount: number;
  source: string;
}

export interface ObfuscationEngine {
  processBatch(
    inputs: EngineFileInput[],
    configJson: string,
    buildContextJson?: string,
  ): Promise<EngineBatchResult>;
  version?(): Promise<string>;
}

export interface CombinedProtectionMapTarget {
  buildDir: string;
  afterpackDir?: string;
  fileName?: string;
}

export interface InMemoryInput {
  source: string;
  inputSourceMap?: string | null;
}

export interface InMemoryOutput {
  filePath: string;
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

export interface ObfuscationPassOptions {
  files: string[];
  inputs?: Map<string, InMemoryInput>;
  emitToCaller?: boolean;
  engine: ObfuscationEngine;
  label: string;
  gitignoreDir: string;
  combinedProtectionMap: CombinedProtectionMapTarget;
  artifactOptions?: AfterpackArtifactOptions;
  hasBundlerSourcemap?: boolean;
  seed?: SeedOption;
  buildLeg?: string;
  preset?: Preset;
  complexity?: number;
  regions?: RegionConfig[];
  engineConfig?: EngineConfigSubset;
  directives?: boolean;
  postMinify?: boolean;
  directivesExplicit?: boolean;
  capturedByFile?: Map<string, CapturedModule[]>;
  env?: EnvLike;
  messages?: PassMessages;
  receipt?: PassReceiptIdentity;
  afterWrite?: () => void;
  diagnostics?: DiagnosticsVerbosity;
  telemetry?: TelemetryReporter;
  clientVersion?: string;
  logger?: Logger;
  startedAt?: number;
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
  policy: ReportPolicy;
  seed: number | string;
  seedOrigin: SeedOrigin;
  timing: PassTiming;
  diagnostics: DiagnosticsSummary;
  transformedFiles: string[];
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

async function readEngineVersion(engine: ObfuscationEngine): Promise<string | null> {
  try {
    return (await engine.version?.()) ?? null;
  } catch {
    return null;
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtSeconds(ms: number): string {
  return (ms / 1000).toFixed(1);
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
    files,
    engine,
    label,
    gitignoreDir,
    combinedProtectionMap,
    artifactOptions = {},
    env = process.env,
  } = options;
  const logger = silenceSummaryLines(options.logger ?? DEFAULT_LOGGER, options.diagnostics);
  const prefix = (message: string): string => `[${label}] ${message}`;

  const onDiskFiles = options.inputs ? files.filter((f) => !options.inputs?.has(f)) : files;
  const onDiskBytes = new Map<string, Buffer>(
    await Promise.all(
      onDiskFiles.map(async (filePath) => [filePath, await readFile(filePath)] as const),
    ),
  );

  if (!options.emitToCaller) {
    const already = detectAlreadyObfuscatedInputs(
      onDiskFiles,
      combinedProtectionMap.buildDir,
      onDiskBytes,
    );
    if (already) {
      throw new Error(
        prefix(
          formatAlreadyObfuscatedMessage({
            files: already.files,
            receiptPath: already.receiptPath,
            dir: combinedProtectionMap.buildDir,
          }),
        ),
      );
    }
  }

  const resolvedSeed = resolveBuildSeed(
    options.seed,
    { root: gitignoreDir, leg: options.buildLeg ?? combinedProtectionMap.buildDir },
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

  const directivesEnabled = options.directives ?? false;
  const bundledCapture = options.capturedByFile != null;
  const postMinifyMode = directivesEnabled && options.postMinify === true && !bundledCapture;

  const sourceByPath = new Map<string, string>();
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
    const inputSourceMap = provided
      ? (provided.inputSourceMap ?? null)
      : discoverInputSourceMap(filePath, source);
    let regions: string | undefined;
    const modules = options.capturedByFile?.get(filePath);
    if (modules?.some((m) => m.directives.length > 0)) {
      const map = parseSourceMap(inputSourceMap);
      if (!map) {
        directivesNeededMap = true;
      } else {
        const colored = colorRegions(source, map, modules, (m) => logger.warn(prefix(m)));
        if (colored.length > 0) {
          regions = JSON.stringify(colored);
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
            regions = JSON.stringify(colored);
            coloredRegionCount += colored.length;
          }
        }
      }
    }
    return { filePath, source, inputSourceMap: inputSourceMap ?? undefined, regions };
  });
  onDiskBytes.clear();

  const hasBundlerSourcemap =
    (options.hasBundlerSourcemap ?? false) || inputs.some((i) => i.inputSourceMap != null);
  const policy = resolveReportPolicy(env, artifactOptions, {
    hasBundlerSourcemap,
    inPlaceOutput: true,
  });
  ensureGitignore(combinedProtectionMap.buildDir);
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
    options.directivesExplicit === true &&
    files.length > 0 &&
    postMinifyMapsSeen === 0 &&
    options.messages?.directivesNeedClientMaps
  ) {
    logger.warn(prefix(options.messages.directivesNeedClientMaps));
  }
  const mappedInputs = inputs.filter((i) => i.inputSourceMap != null).length;
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
      : detectGitContext(artifactOptions.git ?? null, { env, cwd: gitignoreDir });

  const configJson = buildEngineConfigJson({
    policy,
    seed,
    preset: options.preset,
    complexity: options.complexity,
    regions: capture.regions,
    engine: options.engineConfig,
    renameGlobals: capture.renameGlobals,
  });
  logger.log(
    prefix(
      `obfuscating ${inputs.length} file(s) at ${describeLevel(options.preset, options.complexity)} ...`,
    ),
  );
  const engineStartedAt = Date.now();
  const prepMs = engineStartedAt - passStartedAt;
  const batch = await engine.processBatch(inputs, configJson, buildContextJson(git));
  const engineEndedAt = Date.now();
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
    telemetryEnabled || !options.emitToCaller ? await readEngineVersion(engine) : null;
  if (telemetry && telemetryEnabled) {
    const facts: TelemetryFacts = {
      label,
      projectRoot: gitignoreDir,
      diagnostics: collected.diagnostics,
      fileCount: files.length,
      durationMs: engineEndedAt - passStartedAt,
      preset: options.preset,
      complexity: options.complexity,
      engineVersion,
      clientVersion: options.clientVersion ?? null,
    };
    await telemetry(facts);
  }

  const protectionMapDocs: unknown[] = [];
  const sensitiveArtifactPaths: string[] = [];
  const outputs: InMemoryOutput[] = [];
  let inputBytes = 0;
  let outputBytes = 0;
  const unobfuscatedFiles: string[] = [];
  let noOp = 0;
  const transformedFiles: string[] = [];
  const verified: { result: EngineFileResult; source: string }[] = [];
  for (const f of batch.files) {
    const source = sourceByPath.get(f.filePath);
    if (source === undefined) {
      throw new Error(prefix(`no captured source for engine-returned path ${f.filePath}`));
    }
    if (f.status === "failure" || (f.code === "" && source.trim() !== "")) {
      throw new Error(prefix(`failed to obfuscate ${f.filePath}: ${f.error ?? "empty output"}`));
    }

    inputBytes += Buffer.byteLength(source);
    outputBytes += Buffer.byteLength(f.code);
    if (f.unobfuscated === true) unobfuscatedFiles.push(basename(f.filePath));
    else if (f.code === source) noOp += 1;
    else transformedFiles.push(f.filePath);

    if (policy.protectionMap && f.protectionMap != null) {
      protectionMapDocs.push(JSON.parse(f.protectionMap));
    }
    verified.push({ result: f, source });
  }

  if (unobfuscatedFiles.length > 0) {
    if (artifactOptions.allowUnobfuscated === true) {
      for (const name of unobfuscatedFiles) {
        logger.warn(
          prefix(
            `${name} could not be obfuscated and SHIPPED AS CLEARTEXT ` +
              "(allowUnobfuscated:true). This is an engine bug — please report it.",
          ),
        );
      }
    } else {
      throw new Error(
        prefix(
          `${unobfuscatedFiles.length} file(s) could not be obfuscated and would ship ` +
            `as cleartext: ${unobfuscatedFiles.join(", ")} — fix the engine or set ` +
            "allowUnobfuscated:true",
        ),
      );
    }
  }

  const writtenFiles: string[] = [];
  for (const { result: f, source } of verified) {
    if (options.emitToCaller) {
      outputs.push({ filePath: f.filePath, code: f.code, sourceMap: f.sourceMap ?? null });
      continue;
    }
    const written = writeArtifacts({
      outPath: f.filePath,
      code: f.code,
      sourceMapJson: f.sourceMap ?? null,
      protectionMapJson: null,
      originalSource: source,
      policy,
      mode: "framework",
      logger,
    });
    writtenFiles.push(written.codePath);
    if (written.mapPath) sensitiveArtifactPaths.push(written.mapPath);
    if (written.backupPath) sensitiveArtifactPaths.push(written.backupPath);
  }
  if (!options.emitToCaller) options.afterWrite?.();

  const protectionMapPath = writeCombinedProtectionMap({
    buildDir: combinedProtectionMap.buildDir,
    docs: protectionMapDocs,
    policy,
    afterpackDir: combinedProtectionMap.afterpackDir,
    fileName: combinedProtectionMap.fileName,
    logger,
  });
  if (protectionMapPath) sensitiveArtifactPaths.push(protectionMapPath);

  for (const artifactPath of sensitiveArtifactPaths) {
    if (warnIfPublicPath(artifactPath, logger)) break;
  }

  if (!options.emitToCaller) {
    const receiptPath = writeProtectionReceipt({
      dir: combinedProtectionMap.buildDir,
      tool: label,
      engineVersion,
      seed,
      seedOrigin: resolvedSeed.origin,
      bundler: options.receipt?.bundler ?? "unknown",
      buildId: options.receipt?.buildId ?? null,
      files: writtenFiles,
      transformed: transformedFiles,
    });
    logger.log(prefix(`wrote protection receipt -> ${receiptPath} (afterpack verify)`));
  }

  const writeEndedAt = Date.now();
  const writeMs = writeEndedAt - engineEndedAt;
  const totalMs = writeEndedAt - passStartedAt;
  const engineSource = batch.source === "local" || batch.source === "cloud" ? batch.source : null;
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

  const elapsedS = ((writeEndedAt - engineStartedAt) / 1000).toFixed(1);
  const ratio = inputBytes > 0 ? Math.round((outputBytes / inputBytes) * 100) : 100;
  const overheadLabel = engineSource === "cloud" ? "cloud" : "engine";
  logger.log(
    prefix(
      `obfuscated ${files.length} file(s) in ${elapsedS}s · ` +
        `${fmtBytes(inputBytes)} -> ${fmtBytes(outputBytes)} (${ratio}% of input)` +
        ` · seed ${seed} (${resolvedSeed.mismatch ? "MISMATCH" : resolvedSeed.origin})` +
        (unobfuscatedFiles.length > 0
          ? ` · ${unobfuscatedFiles.length} shipped UNOBFUSCATED (fallback, cleartext)`
          : "") +
        (noOp > 0 ? ` · ${noOp} no-op (unchanged)` : "") +
        (protectionMapPath ? ` · protection map -> ${protectionMapPath}` : "") +
        ` · afterpack overhead ${fmtSeconds(totalMs)}s (prep ${fmtSeconds(prepMs)}s · ` +
        `${overheadLabel} ${fmtSeconds(engineMs)}s · write ${fmtSeconds(writeMs)}s)`,
    ),
  );

  return {
    fileCount: files.length,
    protectionMapPath,
    policy,
    seed,
    seedOrigin: resolvedSeed.origin,
    timing,
    diagnostics: diagnosticsSummary,
    transformedFiles,
    ...(options.emitToCaller ? { outputs } : {}),
  };
}
