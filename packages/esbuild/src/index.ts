import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { processBatch, version } from "@afterpack/core";
import {
  type AfterpackPluginOptions,
  collectJsFiles,
  createTelemetryReporter,
  passSettings,
  removeSourceMaps,
  resolveClientIdentity,
  resolvePluginConfig,
  runObfuscationPass,
  sourceTypeForOutputFormat,
  stripCssSourceMappingURLs,
} from "@afterpack/integration-utils";
import type { BuildOptions, BuildResult, Plugin, PluginBuild } from "esbuild";

export type AfterpackEsbuildOptions = AfterpackPluginOptions;

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
    setup(build: PluginBuild) {
      build.onEnd(async (result: BuildResult) => {
        const autorun = settings.build?.autorun ?? true;
        if (!autorun) return;
        if (result.errors.length > 0) return;
        const io = build.initialOptions;
        if (io.write === false) return;

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
