import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AfterpackPluginOptions,
  collectJsFiles,
  collectSourceMaps,
  createTelemetryReporter,
  type ObfuscationEngine,
  resolvePluginConfig,
  runObfuscationPass,
  withSourceMappingURL,
} from "@afterpack/integration-utils";

export const LABEL = "afterpack-next";

export interface AfterProductionCompileMetadata {
  projectDir: string;
  distDir: string;
}

export interface AfterpackHookInput {
  metadata: AfterProductionCompileMetadata;
  options: AfterpackPluginOptions;
  sriAlgorithm?: string;
  engine?: ObfuscationEngine;
  env?: NodeJS.ProcessEnv;
}

const SRI_CONFLICT =
  `[${LABEL}] \`experimental.sri\` is not compatible with AfterPack. Next computes each chunk's ` +
  "integrity hash while writing it, before any build hook runs, so obfuscating the chunk " +
  "afterwards leaves every <script integrity=...> pointing at bytes that no longer exist and the " +
  "browser blocks the script. Remove `experimental.sri` from next.config, or remove " +
  "withAfterpackNext().";

function readBuildIdFromManifest(distDir: string): string | null {
  try {
    const manifest = JSON.parse(
      readFileSync(join(distDir, "build-manifest.json"), "utf8"),
    ) as unknown as { lowPriorityFiles?: string[] };
    for (const file of manifest.lowPriorityFiles ?? []) {
      const match = /^static\/(.+)\/_buildManifest\.js$/.exec(file);
      if (match) return match[1];
    }
    return null;
  } catch {
    return null;
  }
}

function detectBundler(distDir: string): string {
  if (existsSync(join(distDir, "turbopack"))) return "turbopack";
  if (existsSync(join(distDir, "server", "webpack-runtime.js"))) return "webpack";
  return "unknown";
}

function stripDanglingTrailer(js: string): boolean {
  try {
    const code = readFileSync(js, "utf8");
    const stripped = withSourceMappingURL(code, null);
    if (stripped === code) return false;
    writeFileSync(js, stripped);
    return true;
  } catch {
    return false;
  }
}

export function stripServedSourceMaps(
  chunks: string[],
  chunksDir: string,
  log: (message: string) => void = (message) => console.log(message),
): void {
  let removed = 0;
  for (const mapPath of collectSourceMaps(chunksDir)) {
    try {
      unlinkSync(mapPath);
      removed++;
    } catch (e) {
      console.warn(`[${LABEL}] could not remove served source map ${mapPath}: ${e}`);
    }
  }

  let trailers = 0;
  for (const js of chunks) {
    if (stripDanglingTrailer(js)) trailers++;
  }

  if (removed > 0 || trailers > 0) {
    const tail = trailers > 0 ? ` + ${trailers} sourceMappingURL trailer(s)` : "";
    log(`[${LABEL}] stripped ${removed} served source map(s)${tail} from the client tree`);
  }
}

async function loadEngineOnDemand(): Promise<ObfuscationEngine> {
  const core = await import("@afterpack/core");
  return { processBatch: core.processBatch, version: core.version };
}

export async function runAfterpackHook(input: AfterpackHookInput): Promise<void> {
  const startedAt = Date.now();
  const { projectDir, distDir } = input.metadata;
  const sriInConfigOrBuildOutput =
    input.sriAlgorithm !== undefined ||
    existsSync(join(distDir, "server", "subresource-integrity-manifest.json"));
  if (sriInConfigOrBuildOutput) throw new Error(SRI_CONFLICT);

  const resolved = resolvePluginConfig({
    label: LABEL,
    cwd: projectDir,
    options: input.options,
    env: input.env ?? process.env,
  });
  const settings = resolved.options;
  if (settings.build?.autorun === false) {
    if (settings.diagnostics?.level !== "none") {
      console.log(`[${LABEL}] autorun disabled, skipping obfuscation`);
    }
    return;
  }

  const chunksDir = join(distDir, "static", "chunks");
  const files = collectJsFiles(chunksDir, { include: settings.paths?.include });
  if (files.length === 0) {
    throw new Error(
      `[${LABEL}] no client JS found under ${chunksDir} — refusing to report a protected build ` +
        "for a tree nothing was obfuscated in.",
    );
  }

  const engine = input.engine ?? (await loadEngineOnDemand());
  await runObfuscationPass({
    files,
    engine,
    telemetry: createTelemetryReporter(),
    label: LABEL,
    gitignoreDir: projectDir,
    startedAt,
    combinedProtectionMap: { buildDir: distDir, afterpackDir: join(projectDir, ".afterpack") },
    artifactOptions: settings.artifactOptions,
    seed: settings.seed,
    preset: settings.preset,
    complexity: settings.complexity,
    regions: settings.regions,
    engineConfig: resolved.engineConfig,
    diagnostics: settings.diagnostics?.level,
    directives: settings.directives,
    directivesExplicit: settings.directivesExplicit,
    postMinify: true,
    afterWrite: () => {
      stripServedSourceMaps(
        files,
        chunksDir,
        settings.diagnostics?.level === "none" ? () => {} : (message) => console.log(message),
      );
    },
    receipt: {
      bundler: detectBundler(distDir),
      buildId: readBuildIdFromManifest(distDir),
    },
    messages: {
      autoEnableBundlerSourcemap:
        "protectionMap:true but no bundler sourcemap was found. Set " +
        "`productionBrowserSourceMaps: true` in next.config so the Protection Map " +
        "can render your original pre-bundle source.",
      directivesNeedClientMaps:
        "directives are enabled but no client source maps were found. Set " +
        "`productionBrowserSourceMaps: true` in next.config so `/* @afterpack ... */` " +
        "directives can be recovered from the emitted chunks' sourcesContent.",
    },
  });
}
