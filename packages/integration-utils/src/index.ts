export {
  angularServerManifestRefusal,
  planAngularIntegrity,
  recomputeAngularIntegrity,
} from "./angular-integrity.js";
export {
  ensureAfterpackGitignore,
  type Logger,
  type WriteArtifactsInput,
  type WriteArtifactsResult,
  writeArtifacts,
} from "./artifacts.js";
export { sha256Hex, stagedPath, writeFileAtomic } from "./atomic-write.js";
export {
  applyBundleOutput,
  type BundleEntryLike,
  type BundleJs,
  collectBundleJs,
  type OutputBundleLike,
  regenerateCompressedSiblings,
  sourceTypeForBundle,
  sriPluginRefusal,
  stripBundleCssSourceMaps,
  unsaltedAssetsWarning,
} from "./bundle.js";
export {
  type CollectJsOptions,
  collectJsFiles,
  collectSourceMaps,
  collectStylesheets,
} from "./collect.js";
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
export {
  type PreparedHashSalt,
  type PrepareHashSaltInput,
  prepareHashSalt,
  readEngineVersion,
  reportPolicySaltBits,
  type SaltEngine,
  saltSettings,
} from "./hash-salt.js";
export {
  angularHashToken,
  detectNextBundler,
  NEXT_CHUNKS_PREFIX,
  nextChunkToken,
  skipNextInternals,
} from "./hash-tokens.js";
export {
  findHashTokenReference,
  type HashedNamesOptions,
  type HashTokenOf,
  type TokenScanLimits,
  type TokenScanResult,
  unreferencedHashedFiles,
} from "./hashed-names.js";
export {
  AFTERPACK_DIR,
  AfterpackFilesError,
  type AfterpackHome,
  type AfterpackHomeOptions,
  afterpackHome,
  DIAG_AFTERPACK_DIR_IN_OUTPUT,
  DIAG_RECEIPT_UNWRITABLE,
  isWithinDir,
} from "./home.js";
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
  type PassWritePlan,
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
  buildDirKey,
  DIAG_RECEIPT_UNREADABLE,
  type HomeTarget,
  type LocatedReceipt,
  type LocateReceiptOptions,
  locateProtectionReceipt,
  PROTECTION_RECEIPTS_DIR,
  type ProtectionReceipt,
  type ProtectionReceiptFile,
  type ProtectionVerification,
  protectionReceiptPath,
  sha256Of,
  sweepOutputTree,
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
  type SourceType,
  sourceTypeForOutputFormat,
  toEngineConfig,
  toPluginOptions,
  type ValidationResult,
  type ValueShape,
  type ValueType,
  validateConfig,
} from "./registry.js";
export {
  type ResolvedBuildSeed,
  SEED_ENV_VAR,
  type SeedOption,
  type SeedOrigin,
} from "./seed.js";
export {
  decodeDataUri,
  discoverInputSourceMap,
  extractSourceMappingURL,
  removeSourceMaps,
  stripCssSourceMappingURLs,
  withoutCssSourceMappingURL,
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
