import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { type AfterpackPluginOptions, resolvePluginConfig } from "@afterpack/integration-utils";
import { afterpackVite } from "@afterpack/vite";
import type { Plugin, ResolvedConfig } from "vite";
import { recordEnvSeedPinned, recordLegBuilt, warnPackagedTreeLeak } from "./notices.js";

export type ElectronLeg = "main" | "preload" | "renderer";

export type AfterpackElectronOptions = AfterpackPluginOptions & {
  projectRoot?: string;
};

const BYTECODE_PLUGIN = "vite:bytecode";
const BYTECODE_EXT = /\.c?jsc$/;

function collectBytecodeChunks(dir: string, found: string[] = []): string[] {
  if (!existsSync(dir)) return found;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) collectBytecodeChunks(full, found);
    else if (BYTECODE_EXT.test(name)) found.push(full);
  }
  return found;
}

function bytecodeRefusal(leg: string, what: string): Error {
  return new Error(
    `[afterpack-electron:${leg}] ${what}. electron-vite's bytecodePlugin replaces every ` +
      "emitted chunk with a 3-line loader and ships the real application as V8 bytecode " +
      "(.jsc), so AfterPack would obfuscate the loader and report success while the " +
      "application itself went untouched. They cannot compose (bytecode replaces the chunk " +
      "Rollup generated): drop bytecodePlugin, or drop " +
      "AfterPack for this leg.",
  );
}

function guardPlugin(leg: ElectronLeg, seedPinned: boolean): Plugin {
  let outDir = "";
  return {
    name: `afterpack-electron:${leg}`,
    configResolved(config: ResolvedConfig) {
      outDir = resolve(config.root, config.build.outDir);
      recordEnvSeedPinned();
      if (config.plugins.some((p) => p.name === BYTECODE_PLUGIN)) {
        throw bytecodeRefusal(leg, `${BYTECODE_PLUGIN} is enabled for this leg`);
      }
      warnPackagedTreeLeak(config.root, (m) =>
        config.logger ? config.logger.warn(m) : console.warn(m),
      );
    },
    closeBundle() {
      const bytecode = collectBytecodeChunks(outDir);
      if (bytecode.length > 0) {
        throw bytecodeRefusal(leg, `${bytecode.length} V8 bytecode chunk(s) are in ${outDir}`);
      }
      recordLegBuilt(leg, seedPinned);
    },
  };
}

export function afterpackElectron(
  options: AfterpackElectronOptions & { leg: ElectronLeg },
): Plugin[] {
  const { leg, ...rest } = options;
  const resolvedSettings = resolvePluginConfig({
    label: `afterpack-electron:${leg}`,
    options: rest,
    localKeys: ["projectRoot"],
  }).options;
  const artifacts = resolvedSettings.artifactOptions;
  if (artifacts.build?.backup === true) {
    throw new Error(
      `[afterpack-electron:${leg}] build.backup:true writes a .backup.<hash>.js holding the ` +
        "COMPLETE original source next to each output, inside the tree the packager " +
        "copies into app.asar — every user would receive your source. Remove it.",
    );
  }
  if (artifacts.sourceMap?.enabled === true || artifacts.sourceMap?.emitUrl === true) {
    console.warn(
      `[afterpack-electron:${leg}] source maps are enabled. A .map with sourcesContent ` +
        "inside app.asar is full deobfuscation — keep this to local debug builds, and " +
        "exclude *.map from the packaged files.",
    );
  }
  const sharedSeedProjectRoot = rest.projectRoot ?? process.cwd();
  const obfuscationPlugin = afterpackVite({ ...rest, leg, projectRoot: sharedSeedProjectRoot });
  const bytecodeAndSeedGuardPlugin = guardPlugin(leg, resolvedSettings.seed !== undefined);
  return [obfuscationPlugin, bytecodeAndSeedGuardPlugin];
}

const LEGS: ElectronLeg[] = ["main", "preload", "renderer"];

function injectLegs<T extends object>(config: T, options: AfterpackElectronOptions): T {
  const wired: string[] = [];
  for (const leg of LEGS) {
    const legConfig = (config as Record<string, { plugins?: unknown[] } | undefined>)[leg];
    if (!legConfig) continue;
    legConfig.plugins = [...(legConfig.plugins ?? []), afterpackElectron({ ...options, leg })];
    wired.push(leg);
  }
  if (wired.length === 0) {
    throw new Error(
      "[afterpack-electron] withAfterpack() found no main/preload/renderer section on " +
        "this config — it must wrap an electron-vite config, not a plain Vite one.",
    );
  }
  console.log(`[afterpack-electron] wired into legs: ${wired.join(", ")}`);
  return config;
}

export function withAfterpack<T>(config: T, options: AfterpackElectronOptions = {}): T {
  if (typeof config === "function") {
    return ((env: unknown) => {
      const resolved = (config as (e: unknown) => unknown)(env);
      return resolved instanceof Promise
        ? resolved.then((c) => injectLegs(c as object, options))
        : injectLegs(resolved as object, options);
    }) as T;
  }
  if (config instanceof Promise) {
    return config.then((c) => injectLegs(c as object, options)) as T;
  }
  return injectLegs(config as object, options) as T;
}
