import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type AfterpackPluginOptions,
  collectJsFiles,
  collectSourceMaps,
  collectStylesheets,
  createTelemetryReporter,
  type HashTokenOf,
  type ObfuscationEngine,
  passSettings,
  removeSourceMaps,
  resolveClientIdentity,
  resolvePluginConfig,
  runObfuscationPass,
  stripCssSourceMappingURLs,
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
  "withAfterpack().";

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

const TURBOPACK_CHUNK_RE = /^(?:turbopack-)?([0-9a-z~._-]{13})\.(?:js|css)$/;
const WEBPACK_CHUNK_RE = /[-.]([0-9a-f]{16})\.js$/;

export function nextChunkToken(bundler: string): HashTokenOf {
  const pattern =
    bundler === "turbopack" ? TURBOPACK_CHUNK_RE : bundler === "webpack" ? WEBPACK_CHUNK_RE : null;
  return (relativePath) => {
    if (pattern === null || !relativePath.startsWith("static/chunks/")) return null;
    return pattern.exec(basename(relativePath))?.[1] ?? null;
  };
}

function skipNextInternals(relativePath: string): boolean {
  return relativePath === "cache" || relativePath.startsWith("trace");
}

function stripTrailer(path: string): boolean {
  const code = readFileSync(path, "utf8");
  const stripped = withSourceMappingURL(code, null);
  if (stripped === code) return false;
  writeFileSync(path, stripped);
  return true;
}

export function stripServedSourceMaps(
  chunks: string[],
  servedDir: string,
  log: (message: string) => void = (message) => console.log(message),
): void {
  const removed = removeSourceMaps(collectSourceMaps(servedDir), LABEL);
  let trailers = 0;
  for (const js of chunks) {
    if (stripTrailer(js)) trailers++;
  }
  trailers += stripCssSourceMappingURLs(collectStylesheets(servedDir));

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
  const bundler = detectBundler(distDir);
  if (bundler === "unknown") {
    console.warn(
      `[${LABEL}] could not tell whether this build used Turbopack or webpack, so no content-hashed ` +
        "chunk name was changed. The obfuscated chunks keep the plain build's names, and an " +
        "immutable cache may serve stale bytes. Report this with your Next.js version.",
    );
  }
  const buildId = readBuildIdFromManifest(distDir);
  const result = await runObfuscationPass({
    files,
    engine,
    client: resolveClientIdentity(import.meta.url),
    telemetry: createTelemetryReporter(),
    label: LABEL,
    cwd: projectDir,
    startedAt,
    combinedProtectionMap: { buildDir: distDir },
    sourceMapSweepDir: join(distDir, "static"),
    ...passSettings(resolved),
    postMinify: true,
    hashedNames: { root: distDir, tokenOf: nextChunkToken(bundler), skip: skipNextInternals },
    afterWrite: (written) => {
      stripServedSourceMaps(
        written,
        join(distDir, "static"),
        settings.diagnostics?.level === "none" ? () => {} : (message) => console.log(message),
      );
    },
    receipt: {
      bundler,
      buildId,
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

  if (buildId !== null && result.transformedFiles.length > 0) {
    warnIfBuildIdPinned(buildId, settings.diagnostics?.level);
  }
}

function warnIfBuildIdPinned(buildId: string, diagnosticsLevel: string | undefined): void {
  if (diagnosticsLevel === "none") return;
  if (!/^[0-9a-z]{16,}$/i.test(buildId)) {
    console.warn(
      `[${LABEL}] this build's id "${buildId}" is not a random Next id, so \`static/${buildId}/` +
        "_buildManifest.js` and `_ssgManifest.js` keep one immutable URL across releases while " +
        "their bytes change. AfterPack cannot rename the build id — Next writes into " +
        `static/${buildId}/ after the build hook runs. Leave \`generateBuildId\` unset so Next ` +
        "randomizes it per build, or bump it every release.",
    );
  }
}
