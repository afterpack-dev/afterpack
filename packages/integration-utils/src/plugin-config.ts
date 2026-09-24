import { CONFIG_FILE_NAME, loadConfigFile } from "./config-file.js";
import { type CliParseResult, parseCliOptions, parseEnvOptions } from "./config-parse.js";
import type { ObfuscationPassOptions } from "./pass.js";
import type { AfterpackArtifactOptions } from "./policy.js";
import {
  type AfterpackConfig,
  CONFIG_BY_PATH,
  CONFIG_KEYS,
  CONFIG_PREFIXES,
  type ConfigIssue,
  type CoreConfigSubset,
  deepMerge,
  EMPTY_CONFIG,
  getPath,
  isPlainObject,
  mergeConfig,
  type PluginOptionsView,
  toEngineConfig,
  toPluginOptions,
  unknownKeyMessage,
  validateConfig,
} from "./registry.js";

export const PLUGIN_LOCAL_KEYS = [
  "git",
] as const satisfies readonly (keyof AfterpackArtifactOptions)[];

export type AfterpackPluginOptions = Omit<AfterpackConfig, "key"> &
  Pick<AfterpackArtifactOptions, (typeof PLUGIN_LOCAL_KEYS)[number]>;

export interface NormalizedPluginOptions {
  config: Record<string, unknown>;
  issues: ConfigIssue[];
}

function proKeyMessage(surface: string): string {
  return (
    `\`key\` is not a plugin option (${surface}) — no plugin forwards it, and a bundler config is ` +
    "committed source. Set `AFTERPACK_KEY` in the environment, or `key` in afterpack.json, instead " +
    "— without it the build runs locally, without Pro protection."
  );
}

export function normalizePluginOptions(
  input: unknown,
  localKeys: readonly string[],
  surface: string,
): NormalizedPluginOptions {
  const config: Record<string, unknown> = {};
  const issues: ConfigIssue[] = [];
  if (input === undefined || input === null) return { config, issues };
  if (!isPlainObject(input)) {
    issues.push({ path: "", message: `configuration (${surface}) must be an object` });
    return { config, issues };
  }
  const local = new Set([...PLUGIN_LOCAL_KEYS, ...localKeys]);
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined || local.has(name)) continue;
    if (name === "key") {
      issues.push({ path: name, message: proKeyMessage(surface) });
      continue;
    }
    if (CONFIG_BY_PATH.has(name)) {
      config[name] = value;
      continue;
    }
    if (CONFIG_PREFIXES.has(name)) {
      const existing = config[name];
      config[name] =
        isPlainObject(value) && isPlainObject(existing) ? deepMerge(existing, value) : value;
      continue;
    }
    issues.push({ path: name, message: unknownKeyMessage(name, surface) });
  }
  return { config, issues };
}

export interface PluginConfigInput {
  label: string;
  options?: unknown;
  argv?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  localKeys?: readonly string[];
  unsupported?: Readonly<Record<string, string>>;
}

export interface ResolvedPluginConfig {
  config: AfterpackConfig;
  options: PluginOptionsView;
  engineConfig: CoreConfigSubset;
  configFile: string | null;
  positionals: string[];
  help: boolean;
  version: boolean;
}

export type PassSettings = Pick<
  ObfuscationPassOptions,
  | "artifactOptions"
  | "seed"
  | "preset"
  | "complexity"
  | "regions"
  | "engineConfig"
  | "diagnostics"
  | "directivesEnabled"
  | "directivesEnabledExplicit"
>;

export function passSettings(
  resolved: Pick<ResolvedPluginConfig, "options" | "engineConfig">,
): PassSettings {
  const settings = resolved.options;
  return {
    artifactOptions: settings.artifactOptions,
    seed: settings.seed,
    preset: settings.preset,
    complexity: settings.complexity,
    regions: settings.regions,
    engineConfig: resolved.engineConfig,
    diagnostics: settings.diagnostics?.level,
    directivesEnabled: settings.directives.enabled,
    directivesEnabledExplicit: settings.directives.explicit,
  };
}

function unsupportedIssues(
  unsupported: Readonly<Record<string, string>> | undefined,
  merged: AfterpackConfig,
  layers: readonly { name: string; config: AfterpackConfig }[],
): string[] {
  if (!unsupported) return [];
  const out: string[] = [];
  for (const [path, reason] of Object.entries(unsupported)) {
    const resolved = getPath(merged, path);
    if (resolved === undefined || resolved === false) continue;
    if (Array.isArray(resolved) && resolved.length === 0) continue;
    const from = [...layers].reverse().find((l) => getPath(l.config, path) !== undefined);
    out.push(`  ${from?.name ?? "configuration"}: \`${path}\` is not supported here — ${reason}`);
  }
  return out;
}

export function applyResolvedKey(
  config: AfterpackConfig,
  env: Record<string, string | undefined> = process.env,
): void {
  const key = getPath(config, "key");
  if (typeof key === "string" && key !== "") env.AFTERPACK_KEY = key;
}

function sameRankConflicts(options: AfterpackConfig, cli: AfterpackConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  for (const key of CONFIG_KEYS) {
    const fromOptions = getPath(options, key.path);
    const fromCli = getPath(cli, key.path);
    if (fromOptions === undefined || fromCli === undefined) continue;
    if (JSON.stringify(fromOptions) === JSON.stringify(fromCli)) continue;
    issues.push({
      path: key.path,
      message:
        `\`${key.path}\` is set twice at the same precedence — the options object says ` +
        `${JSON.stringify(fromOptions)}, the command line says ${JSON.stringify(fromCli)}. ` +
        "A flag and an option rank equally, so neither wins: set it in one of them, or move " +
        "it to afterpack.json.",
    });
  }
  return issues;
}

const NO_ARGV: CliParseResult = {
  config: EMPTY_CONFIG,
  positionals: [],
  help: false,
  version: false,
  issues: [],
};

function argvOnlyAnswer(cli: CliParseResult): ResolvedPluginConfig {
  const config = EMPTY_CONFIG;
  return {
    config,
    options: toPluginOptions(config),
    engineConfig: toEngineConfig(config),
    configFile: null,
    positionals: cli.positionals,
    help: cli.help,
    version: cli.version,
  };
}

export function resolvePluginConfig(input: PluginConfigInput): ResolvedPluginConfig {
  const cli = input.argv ? parseCliOptions(input.argv) : NO_ARGV;
  if (cli.help || cli.version) return argvOnlyAnswer(cli);

  const file = loadConfigFile(input.cwd ?? process.cwd());
  const env = parseEnvOptions(input.env ?? process.env);
  const localKeys = input.localKeys ?? [];
  const optionsSurface = `the ${input.label} options object`;
  const normalized = normalizePluginOptions(input.options, localKeys, optionsSurface);
  const options = validateConfig(normalized.config, optionsSurface);
  const explicit = mergeConfig(options.config, cli.config);
  const config = mergeConfig(mergeConfig(file.config, env.config), explicit);
  const issues: string[] = [
    ...file.issues.map((i) => `  ${file.path ?? CONFIG_FILE_NAME}: ${i.message}`),
    ...env.issues.map((i) => `  environment: ${i.message}`),
    ...[...normalized.issues, ...options.issues].map((i) => `  ${optionsSurface}: ${i.message}`),
    ...cli.issues.map((i) => `  command line: ${i.message}`),
    ...sameRankConflicts(options.config, cli.config).map((i) => `  ${i.message}`),
    ...unsupportedIssues(input.unsupported, config, [
      { name: file.path ?? CONFIG_FILE_NAME, config: file.config },
      { name: "environment", config: env.config },
      { name: optionsSurface, config: options.config },
      { name: "command line", config: cli.config },
    ]),
  ];
  if (issues.length > 0) {
    throw new Error(
      [`[${input.label}] refusing to build with an invalid configuration:`, ...issues].join("\n"),
    );
  }
  applyResolvedKey(config, input.env ?? process.env);
  const pluginOptions = toPluginOptions(config);
  const supplied = isPlainObject(input.options) ? input.options : {};
  const localArtifactOptions: Record<string, unknown> = {};
  for (const name of PLUGIN_LOCAL_KEYS) {
    if (supplied[name] !== undefined) localArtifactOptions[name] = supplied[name];
  }
  return {
    config,
    options: {
      ...pluginOptions,
      artifactOptions: { ...pluginOptions.artifactOptions, ...localArtifactOptions },
    },
    engineConfig: toEngineConfig(config),
    configFile: file.path,
    positionals: cli.positionals,
    help: false,
    version: false,
  };
}
