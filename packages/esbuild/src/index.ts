import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { processBatch, version } from "@afterpack/core";
import {
  type AfterpackPluginOptions,
  collectJsFiles,
  createTelemetryReporter,
  passSettings,
  resolveClientIdentity,
  resolvePluginConfig,
  runObfuscationPass,
} from "@afterpack/integration-utils";
import type { BuildOptions, BuildResult, Plugin, PluginBuild } from "esbuild";

export type AfterpackEsbuildOptions = AfterpackPluginOptions;

function resolveOutputs(
  io: BuildOptions,
  cwd: string,
  include: readonly string[] | undefined,
): { files: string[]; buildDir: string } {
  if (io.outdir) {
    const dir = isAbsolute(io.outdir) ? io.outdir : resolve(cwd, io.outdir);
    return { files: collectJsFiles(dir, { include }), buildDir: dir };
  }
  if (io.outfile) {
    const file = isAbsolute(io.outfile) ? io.outfile : resolve(cwd, io.outfile);
    return { files: existsSync(file) ? [file] : [], buildDir: dirname(file) };
  }
  return { files: [], buildDir: cwd };
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
        const { files, buildDir } = resolveOutputs(io, cwd, settings.paths?.include);
        if (files.length === 0) return;

        const gitignoredNonServedAfterpackDir = join(cwd, ".afterpack");
        await runObfuscationPass({
          files,
          engine: { processBatch, version },
          client: resolveClientIdentity(import.meta.url),
          telemetry: createTelemetryReporter(),
          label: "afterpack-esbuild",
          cwd,
          startedAt: startedBeforeOutputWalk,
          combinedProtectionMap: { buildDir, afterpackDir: gitignoredNonServedAfterpackDir },
          ...passSettings(resolved),
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
      });
    },
  };
}
