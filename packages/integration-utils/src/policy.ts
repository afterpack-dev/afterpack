import type { GitBuildContext } from "./git.js";
import {
  type BuildMode,
  type CoreConfigSubset,
  mergeInto,
  PRESET_VALUES,
  type TRANSFORM_KIND_VALUES,
} from "./registry.js";

export interface EnvLike {
  NODE_ENV?: string;
  CI?: string;
  [key: string]: string | undefined;
}

export interface AfterpackArtifactOptions {
  protectionMap?: {
    enabled?: boolean;
  };
  sourceMap?: {
    enabled?: boolean;
    emitUrl?: boolean;
  };
  build?: {
    backup?: boolean;
    mode?: BuildMode;
  };
  allowUnobfuscated?: boolean;
  telemetry?: {
    enabled?: boolean;
  };
  git?: GitBuildContext | false;
}

export interface ReportPolicySignals {
  hasBundlerSourcemap?: boolean;
  inPlaceOutput?: boolean;
}

export interface ReportPolicy {
  isProduction: boolean;
  protectionMap: boolean;
  autoEnableBundlerSourcemap: boolean;
  sourceMap: boolean;
  emitSourceMappingURL: boolean;
  backup: boolean;
  protectionMapInProd: boolean;
  engineSourceMapOverride?: boolean;
}

export function detectProduction(env: EnvLike = {}, opts: AfterpackArtifactOptions = {}): boolean {
  if (opts.build?.mode !== undefined) return opts.build.mode === "production";
  return env.NODE_ENV === "production" || env.CI === "true";
}

export function resolveReportPolicy(
  env: EnvLike = {},
  userOpts: AfterpackArtifactOptions = {},
  signals: ReportPolicySignals = {},
): ReportPolicy {
  const isProduction = detectProduction(env, userOpts);
  const hasBundlerSourcemap = signals.hasBundlerSourcemap ?? false;

  const protectionMap = userOpts.protectionMap?.enabled ?? hasBundlerSourcemap;
  const autoEnableBundlerSourcemap =
    userOpts.protectionMap?.enabled === true && !hasBundlerSourcemap;

  const emitSourceMappingURL = userOpts.sourceMap?.emitUrl ?? !isProduction;
  const backup = userOpts.build?.backup ?? !signals.inPlaceOutput;
  const sourceMap = userOpts.sourceMap?.enabled ?? !isProduction;

  return {
    isProduction,
    protectionMap,
    autoEnableBundlerSourcemap,
    sourceMap,
    emitSourceMappingURL,
    backup,
    protectionMapInProd: isProduction && protectionMap,
    engineSourceMapOverride: userOpts.sourceMap?.enabled ?? (isProduction ? false : undefined),
  };
}

export function resolveSourceMapEnabled(
  sourceMapOverride: boolean | undefined,
  hasInputMap: boolean,
): boolean {
  if (sourceMapOverride === false) return false;
  if (sourceMapOverride === true) return true;
  return hasInputMap;
}

export type Preset = (typeof PRESET_VALUES)[number];

export const PRESETS: readonly Preset[] = PRESET_VALUES;

export const DEFAULT_PRESET: Preset = "light";

export function presetTarget(preset: Preset): number {
  switch (preset) {
    case "minify":
      return 0;
    case "light":
      return 2;
    case "medium":
      return 8;
    case "hard":
      return 25;
    case "extreme":
      return 80;
  }
}

export function effectiveComplexityTarget(preset?: Preset, complexity?: number): number {
  return complexity ?? presetTarget(preset ?? DEFAULT_PRESET);
}

export type TransformKind = (typeof TRANSFORM_KIND_VALUES)[number];

export interface RegionConfig {
  start: number;
  end: number;
  target?: number;
  max?: number;
  floor?: boolean;
  only?: TransformKind[];
  deny?: TransformKind[];
  label?: string;
}

export interface BuildEngineConfigOptions {
  filePath?: string;
  inputSourceMap?: string | null;
  policy: ReportPolicy;
  preset?: Preset;
  complexity?: number;
  seed?: number | string;
  sourcesContent?: boolean;
  regions?: RegionConfig[];
  renameGlobals?: boolean;
  engine?: CoreConfigSubset;
}

export interface CoreConfig extends CoreConfigSubset {
  seed: number | string;
  preset?: Preset;
  sourceMap: { enabled?: boolean; sourcesContent: boolean };
  inputSourceMap?: string;
  filePath?: string;
  protectionMap: { enabled: boolean; detailed?: boolean };
  regions?: RegionConfig[];
}

export function buildEngineConfig(options: BuildEngineConfigOptions): CoreConfig {
  const { filePath, policy, seed = 0, engine } = options;
  const perFileMap = "inputSourceMap" in options;
  const inputSourceMap = options.inputSourceMap ?? null;
  const sourcesContent = options.sourcesContent ?? !policy.isProduction;

  const smEnabled: boolean | undefined = perFileMap
    ? resolveSourceMapEnabled(policy.engineSourceMapOverride, inputSourceMap != null)
    : policy.engineSourceMapOverride;

  const sourceMap: CoreConfig["sourceMap"] = { sourcesContent };
  if (smEnabled !== undefined) sourceMap.enabled = smEnabled;

  const defaults: {
    preset?: Preset;
    complexity?: number;
  } = {};
  const target = effectiveComplexityTarget(options.preset, options.complexity);
  if (options.preset !== undefined) defaults.preset = options.preset;
  if (options.preset === undefined || options.complexity !== undefined) {
    defaults.complexity = target;
  }
  const config = mergeInto<CoreConfig>(
    { ...defaults, sourceMap, protectionMap: { enabled: policy.protectionMap } },
    (engine ?? {}) as Record<string, unknown>,
  );
  config.seed = seed;
  if (options.renameGlobals === true) {
    config.identifiers = { ...config.identifiers, globals: { rename: true } };
  }
  if (filePath !== undefined) config.filePath = filePath;
  if (perFileMap && smEnabled && inputSourceMap != null) {
    config.inputSourceMap = inputSourceMap;
  }
  if (options.regions !== undefined) config.regions = options.regions;
  return config;
}

export interface ClientContext {
  clientVersion?: string | null;
  client?: string | null;
}

export interface BuildContext {
  commitSha?: string;
  ref?: string;
  clientVersion?: string;
  client?: string;
}

export function buildContext(
  git: GitBuildContext | null | undefined,
  client: ClientContext = {},
): BuildContext | undefined {
  const context: BuildContext = {};
  if (git?.commitSha) context.commitSha = git.commitSha;
  if (git?.ref) context.ref = git.ref;
  if (client.clientVersion) context.clientVersion = client.clientVersion;
  if (client.client) context.client = client.client;
  return Object.keys(context).length > 0 ? context : undefined;
}
