export {
  ensureAfterpackGitignore,
  type Logger,
  type WriteArtifactsInput,
  type WriteArtifactsResult,
  writeArtifacts,
} from "./artifacts.js";
export {
  applyBundleOutput,
  type BundleEntryLike,
  type BundleJs,
  collectBundleJs,
  type OutputBundleLike,
} from "./bundle.js";
export { type CollectJsOptions, collectJsFiles, collectSourceMaps } from "./collect.js";
export {
  CLOUD_REFUSAL_SUMMARY,
  type ClientIdentity,
  CloudApiError,
  type CloudErrorKind,
  CORE_FLOOR_SUMMARY,
  CoreVersionError,
  installedRequiredLine,
  npxAlternative,
  resolveClientIdentity,
  serverAddsInfo,
} from "./compat.js";
export { CONFIG_FILE_NAME, type LoadedConfigFile, loadConfigFile } from "./config-file.js";
export {
  type CliParseResult,
  type EnvParseResult,
  parseCliOptions,
  parseEnvOptions,
} from "./config-parse.js";
export {
  AlreadyObfuscatedError,
  DIAG_ALREADY_OBFUSCATED,
  type DiagnosticsSummary,
  type DiagnosticsVerbosity,
  type EngineDiagnostic,
  type EngineDiagnosticData,
  type EngineSeverity,
  type EngineSpan,
} from "./diagnostics.js";
export {
  type CapturedDirective,
  type DirectiveDiagnostic,
  type DirectiveManifest,
  scanDirectives,
} from "./directives.js";
export type { GitBuildContext } from "./git.js";
export type { CapturedModule } from "./map-color.js";
export {
  type CloudNotice,
  type NoticeLogger,
  type NoticeSeverity,
  type SafeNotice,
  sanitizeNotices,
} from "./notices.js";
export {
  type CombinedProtectionMapTarget,
  type EngineBatchResult,
  type EngineFileInput,
  type EngineFileResult,
  type InMemoryInput,
  type InMemoryOutput,
  type ObfuscationEngine,
  type ObfuscationPassOptions,
  type ObfuscationPassResult,
  type PassMessages,
  type PassReceiptIdentity,
  type PassTiming,
  runObfuscationPass,
} from "./pass.js";
export { type ArtifactMode, findUpward } from "./paths.js";
export {
  type AfterpackPluginOptions,
  applyResolvedKey,
  type NormalizedPluginOptions,
  normalizePluginOptions,
  type PassSettings,
  type PluginConfigInput,
  passSettings,
  type ResolvedPluginConfig,
  resolvePluginConfig,
} from "./plugin-config.js";
export {
  type AfterpackArtifactOptions,
  type BuildContext,
  type BuildEngineConfigOptions,
  type CoreConfig,
  type EnvLike,
  type Preset,
  type RegionConfig,
  type ReportPolicy,
  type ReportPolicySignals,
  resolveReportPolicy,
  type TransformKind,
} from "./policy.js";
export {
  DIAG_RECEIPT_UNREADABLE,
  PROTECTION_RECEIPT_FILE,
  type ProtectionReceipt,
  type ProtectionReceiptFile,
  type ProtectionVerification,
  sha256Of,
  UnreadableReceiptError,
  verifyProtectionReceipt,
  type WriteProtectionReceiptInput,
  writeDeferredProtectionReceipt,
  writeProtectionReceipt,
} from "./receipt.js";
export {
  type AfterpackConfig,
  CONFIG_KEYS,
  type ConfigIssue,
  type ConfigKeyDef,
  type ConfigScope,
  type ConfigSurface,
  type ConfigTier,
  type CoreConfigSubset,
  type GlobReserved,
  getPath,
  mergeConfig,
  type PluginOptionsView,
  toEngineConfig,
  toPluginOptions,
  type ValidationResult,
  type ValueShape,
  type ValueType,
  validateConfig,
} from "./registry.js";
export { SEED_ENV_VAR, type SeedOption, type SeedOrigin } from "./seed.js";
export {
  decodeDataUri,
  discoverInputSourceMap,
  extractSourceMappingURL,
  withSourceMappingURL,
} from "./source-map.js";
export {
  createTelemetryReporter,
  type TelemetryContext,
  type TelemetryDiagnostic,
  type TelemetryDiagnosticData,
  type TelemetryFacts,
  type TelemetryPayload,
  type TelemetryReporter,
  type TelemetryReporterDeps,
  type TelemetrySeverity,
  type TelemetrySpan,
} from "./telemetry.js";
