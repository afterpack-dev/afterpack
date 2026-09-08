import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as api from "./index.js";

const SURFACE = [
  "AfterpackArtifactOptions",
  "AfterpackConfig",
  "AfterpackPluginOptions",
  "ArtifactMode",
  "BuildEngineConfigOptions",
  "CONFIG_FILE_NAME",
  "CONFIG_KEYS",
  "CapturedDirective",
  "CapturedModule",
  "CliParseResult",
  "CollectJsOptions",
  "CombinedProtectionMapTarget",
  "ConfigIssue",
  "ConfigKeyDef",
  "ConfigScope",
  "ConfigSurface",
  "ConfigTier",
  "DiagnosticsSummary",
  "DiagnosticsVerbosity",
  "DirectiveDiagnostic",
  "DirectiveManifest",
  "EngineBatchResult",
  "EngineConfig",
  "EngineConfigSubset",
  "EngineDiagnostic",
  "EngineDiagnosticData",
  "EngineFileInput",
  "EngineFileResult",
  "EngineSeverity",
  "EngineSpan",
  "EnvLike",
  "EnvParseResult",
  "GitBuildContext",
  "GlobReserved",
  "InMemoryInput",
  "InMemoryOutput",
  "LoadedConfigFile",
  "Logger",
  "NormalizedPluginOptions",
  "ObfuscationEngine",
  "ObfuscationPassOptions",
  "ObfuscationPassResult",
  "PROTECTION_RECEIPT_FILE",
  "PassMessages",
  "PassReceiptIdentity",
  "PassTiming",
  "PluginConfigInput",
  "PluginOptionsView",
  "Preset",
  "ProtectionReceipt",
  "ProtectionReceiptFile",
  "ProtectionVerification",
  "RegionConfig",
  "ReportPolicy",
  "ReportPolicySignals",
  "ResolvedPluginConfig",
  "SEED_ENV_VAR",
  "SeedOption",
  "SeedOrigin",
  "TelemetryContext",
  "TelemetryDiagnostic",
  "TelemetryDiagnosticData",
  "TelemetryFacts",
  "TelemetryPayload",
  "TelemetryReporter",
  "TelemetryReporterDeps",
  "TelemetrySeverity",
  "TelemetrySpan",
  "TransformKind",
  "ValidationResult",
  "ValueShape",
  "ValueType",
  "WriteArtifactsInput",
  "WriteArtifactsResult",
  "WriteProtectionReceiptInput",
  "buildEngineConfigJson",
  "collectJsFiles",
  "collectSourceMaps",
  "BundleEntryLike",
  "BundleJs",
  "OutputBundleLike",
  "applyBundleOutput",
  "applyResolvedKey",
  "collectBundleJs",
  "createTelemetryReporter",
  "decodeDataUri",
  "discoverInputSourceMap",
  "extractSourceMappingURL",
  "getPath",
  "loadConfigFile",
  "mergeConfig",
  "normalizePluginOptions",
  "parseCliOptions",
  "parseEnvOptions",
  "resolvePluginConfig",
  "resolveReportPolicy",
  "runObfuscationPass",
  "scanDirectives",
  "sha256Of",
  "toEngineConfig",
  "toPluginOptions",
  "validateConfig",
  "withSourceMappingURL",
  "verifyProtectionReceipt",
  "writeArtifacts",
  "writeProtectionReceipt",
];

function declaredExports(): string[] {
  const source = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
  const names = new Set<string>();
  for (const block of source.matchAll(/export\s*(?:type\s+)?\{([^}]*)\}/g)) {
    for (const raw of block[1].split(",")) {
      const name = raw
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name) names.add(name);
    }
  }
  return [...names].sort();
}

function report(label: string, names: string[]): string {
  return `${label}:\n  ${names.join("\n  ")}`;
}

describe("the published surface of @afterpack/integration-utils", () => {
  it("exports exactly the pinned list, and nothing that merely drifted in", () => {
    const declared = declaredExports();
    const allowed = new Set(SURFACE);
    const added = declared.filter((name) => !allowed.has(name));
    const removed = SURFACE.filter((name) => !declared.includes(name));
    expect(
      added.length === 0,
      report(
        "index.ts exports names this package has not committed to. Every name here is a " +
          "runtime dependency of eight published plugins. Prove a plugin or packages/cli " +
          "imports each one (or that an exported signature names the type), then add it to " +
          "SURFACE in index.guard.test.ts. Otherwise leave it on its own module",
        added,
      ),
    ).toBe(true);
    expect(
      removed.length === 0,
      report("SURFACE lists names index.ts no longer exports — delete them from SURFACE", removed),
    ).toBe(true);
    expect(declared).toEqual([...SURFACE].sort());
  });

  it("agrees with what the module actually evaluates to at runtime", () => {
    expect(Object.keys(api).filter((name) => !SURFACE.includes(name))).toEqual([]);
  });

  it("keeps the side-effecting and test-seam helpers off the surface", () => {
    for (const name of [
      "resetBuildSessions",
      "buildProjectFileTree",
      "renameGlobalsRefusalMessage",
      "colorRegions",
      "warnIfPublicPath",
      "misdirectedHint",
      "misdirectedTo",
      "checkItem",
      "checkValue",
      "parseDirectivePayload",
      "PLUGIN_LOCAL_KEYS",
    ]) {
      expect(SURFACE).not.toContain(name);
    }
  });
});
