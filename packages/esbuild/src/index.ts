import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { processBatch, version } from "@afterpack/core";
import {
  type AfterpackPluginOptions,
  collectJsFiles,
  createTelemetryReporter,
  passSettings,
  prepareHashSalt,
  readEngineVersion,
  removeSourceMaps,
  reportPolicySaltBits,
  resolveClientIdentity,
  resolvePluginConfig,
  runObfuscationPass,
  saltSettings,
  sourceTypeForOutputFormat,
  stripCssSourceMappingURLs,
} from "@afterpack/integration-utils";
import type { BuildOptions, BuildResult, Plugin, PluginBuild } from "esbuild";

export type AfterpackEsbuildOptions = AfterpackPluginOptions;

function outputBuildDir(io: BuildOptions, cwd: string): string {
  if (io.outdir) return isAbsolute(io.outdir) ? io.outdir : resolve(cwd, io.outdir);
  if (io.outfile) return dirname(isAbsolute(io.outfile) ? io.outfile : resolve(cwd, io.outfile));
  return cwd;
}

function resolveOutputs(
  io: BuildOptions,
  cwd: string,
  include: readonly string[] | undefined,
): { files: string[]; buildDir: string; sweepDir: string | null } {
  if (io.outdir) {
    const dir = isAbsolute(io.outdir) ? io.outdir : resolve(cwd, io.outdir);
    return { files: collectJsFiles(dir, { include }), buildDir: dir, sweepDir: dir };
  }
  if (io.outfile) {
    const file = isAbsolute(io.outfile) ? io.outfile : resolve(cwd, io.outfile);
    return { files: existsSync(file) ? [file] : [], buildDir: dirname(file), sweepDir: null };
  }
  return { files: [], buildDir: cwd, sweepDir: null };
}

const POST_MINIFY_DIRECTIVE_RECOVERY = true;

export function afterpackEsbuild(options: AfterpackEsbuildOptions = {}): Plugin {
  const resolved = resolvePluginConfig({ label: "afterpack-esbuild", options });
  const settings = resolved.options;
  return {
    name: "afterpack-esbuild",
    async setup(build: PluginBuild) {
      const autorun = settings.build?.autorun ?? true;
      const initial = build.initialOptions;
      if (!autorun || initial.write === false) return;
      const initialCwd = initial.absWorkingDir ?? process.cwd();
      const hashSalt = await prepareHashSalt({
        seed: settings.seed,
        root: initialCwd,
        leg: outputBuildDir(initial, initialCwd),
        localEngineVersion: await readEngineVersion({ version }),
        settings: saltSettings(passSettings(resolved), {
          format: initial.format ?? null,
          sourcemap: initial.sourcemap ?? null,
          pathsInclude: settings.paths?.include ?? null,
          ...reportPolicySaltBits(
            process.env,
            settings.artifactOptions,
            Boolean(initial.sourcemap),
          ),
        }),
        warn: (message) => console.warn(message),
      });
      const banner = initial.banner?.js;
      initial.banner = {
        ...initial.banner,
        js: `${banner ? `${banner}\n` : ""}/*afterpack:${hashSalt.salt}*/`,
      };
      build.onEnd(async (result: BuildResult) => {
        if (result.errors.length > 0) return;
        const io = build.initialOptions;

        const startedBeforeOutputWalk = Date.now();
        const cwd = io.absWorkingDir ?? process.cwd();
        const { files, buildDir, sweepDir } = resolveOutputs(io, cwd, settings.paths?.include);
        if (files.length === 0) return;

        const pass = await runObfuscationPass({
          files,
          engine: { processBatch, version },
          client: resolveClientIdentity(import.meta.url),
          telemetry: createTelemetryReporter(),
          label: "afterpack-esbuild",
          cwd,
          resolvedSeed: hashSalt.resolvedSeed,
          cloudEngineExpectation: hashSalt.engine,
          startedAt: startedBeforeOutputWalk,
          combinedProtectionMap: { buildDir },
          sourceMapSweepDir: sweepDir,
          ...passSettings(resolved),
          sourceType: sourceTypeForOutputFormat(io.format),
          hasBundlerSourcemap: Boolean(io.sourcemap),
          postMinify: POST_MINIFY_DIRECTIVE_RECOVERY,
          messages: {
            autoEnableBundlerSourcemap:
              "protectionMap:true but no bundler sourcemap was found; set `sourcemap: true` " +
              "so future builds can render original source in the map.",
            directivesNeedClientMaps:
              "`directives.enabled` is true but no emitted file carried a source map with `sourcesContent`; " +
              "set `sourcemap: true` so `/* @afterpack ... */` directives can be recovered from " +
              "the emitted chunks. No directive was applied to this build.",
          },
        });
        if (sweepDir === null && !pass.policy.sourceMap) {
          const css = `${files[0].replace(/\.[cm]?js$/, "")}.css`;
          removeSourceMaps([`${css}.map`], "afterpack-esbuild");
          stripCssSourceMappingURLs([css]);
        }
      });
    },
  };
}
