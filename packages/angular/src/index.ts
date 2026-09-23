import { join, resolve } from "node:path";
import { processBatch, version } from "@afterpack/core";
import {
  type AfterpackPluginOptions,
  collectJsFiles,
  createTelemetryReporter,
  resolveClientIdentity,
  resolvePluginConfig,
  runObfuscationPass,
} from "@afterpack/integration-utils";
import { findAngularBrowserDir } from "./browser-dir.js";

export type AfterpackAngularOptions = Omit<AfterpackPluginOptions, "directives"> & {
  cwd?: string;
  distRoot?: string;
  browserDir?: string;
};

const LOCAL_KEYS = ["cwd", "distRoot", "browserDir"] as const;

const DIRECTIVES_UNSUPPORTED =
  "the Angular application builder is sealed (no plugin hook), so this postbuild pass " +
  "only ever sees already-minified output and cannot capture `/* @afterpack ... */` " +
  "comments. Remove the key; to use directives, build through a bundler AfterPack can " +
  "hook (@afterpack/vite, @afterpack/webpack, @afterpack/esbuild).";

const DIRECTIVES_ALWAYS_DISABLED = false;

export async function afterpackAngular(options: AfterpackAngularOptions = {}): Promise<void> {
  const startedBeforeDirDiscovery = Date.now();
  const cwd = options.cwd ?? process.cwd();
  const resolved = resolvePluginConfig({
    label: "afterpack-angular",
    options,
    cwd,
    localKeys: LOCAL_KEYS,
    unsupported: { directives: DIRECTIVES_UNSUPPORTED },
  });
  const settings = resolved.options;
  if (settings.build?.autorun === false) {
    if (settings.diagnostics?.level !== "none") {
      console.log("[afterpack-angular] autorun disabled, skipping obfuscation");
    }
    return;
  }
  const browserDir =
    options.browserDir ?? findAngularBrowserDir(resolve(cwd, options.distRoot ?? "dist"));
  const files = collectJsFiles(browserDir, { include: settings.paths?.include });
  if (files.length === 0) {
    throw new Error(`@afterpack/angular: no .js/.mjs/.cjs files found under ${browserDir}`);
  }
  const gitignoredNonServedAfterpackDir = join(cwd, ".afterpack");
  await runObfuscationPass({
    files,
    engine: { processBatch, version },
    client: resolveClientIdentity(import.meta.url),
    telemetry: createTelemetryReporter(),
    label: "afterpack-angular",
    gitignoreDir: cwd,
    startedAt: startedBeforeDirDiscovery,
    combinedProtectionMap: { buildDir: browserDir, afterpackDir: gitignoredNonServedAfterpackDir },
    artifactOptions: settings.artifactOptions,
    seed: settings.seed,
    preset: settings.preset,
    complexity: settings.complexity,
    regions: settings.regions,
    engineConfig: resolved.engineConfig,
    diagnostics: settings.diagnostics?.level,
    directives: DIRECTIVES_ALWAYS_DISABLED,
  });
}
