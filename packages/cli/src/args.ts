import {
  type AfterpackConfig,
  CONFIG_KEYS,
  type ConfigKeyDef,
  type EngineConfigSubset,
  type PluginOptionsView,
  toEngineConfig,
  toPluginOptions,
} from "@afterpack/integration-utils";
import { OUTPUT_DIRS } from "./detect.js";
import { EXIT_CODE_HELP } from "./exit.js";
import { dim } from "./format.js";

export interface CliRunOptions extends PluginOptionsView {
  pathsInclude: string[];
  engineConfig: EngineConfigSubset;
}

export function toRunOptions(config: AfterpackConfig): CliRunOptions {
  const view = toPluginOptions(config);
  return {
    ...view,
    pathsInclude: view.paths?.include ?? [],
    engineConfig: toEngineConfig(config),
  };
}

export function expandShortFlags(argv: readonly string[]): string[] {
  return argv.map((token) => (token === "-h" ? "--help" : token === "-v" ? "--version" : token));
}

export interface SubcommandArgs {
  positionals: string[];
  help: boolean;
  issues: string[];
}

export function parseSubcommandArgs(argv: readonly string[], command: string): SubcommandArgs {
  const positionals: string[] = [];
  const issues: string[] = [];
  let help = false;
  for (const token of argv) {
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    if (token === "--help") {
      help = true;
      continue;
    }
    if (/^--diagnostics\.(format|level)=/.test(token)) continue;
    issues.push(
      `\`${token}\` is not an option of \`afterpack ${command}\` — it reads no engine ` +
        "configuration, so it takes only `--diagnostics.format=` and `--diagnostics.level=`",
    );
  }
  return { positionals, help, issues };
}

function renderItem(key: ConfigKeyDef): string {
  switch (key.item.kind) {
    case "boolean":
      return "true|false";
    case "number":
      return key.item.integer ? "integer" : "number";
    case "unbounded":
      return `number|${key.item.unlimited}`;
    case "string":
      return "string";
    case "enum":
      return key.item.values.join("|");
    case "seed":
      return "number|string|git";
    case "reserved":
      return "name";
    case "region":
      return "object";
  }
}

export function renderFlag(key: ConfigKeyDef): string {
  if (key.shape === "structured") return `${key.path} (afterpack.json only)`;
  const item = renderItem(key);
  return `--${key.path}=<${key.shape === "scalar" ? item : `${item}[,...]`}>`;
}

export const CONTACT_FOOTER = "contact https://www.afterpack.dev/contact";

export const USAGE =
  "usage: afterpack [path] [--key=value ...] [--help] [--version]\n" +
  "       afterpack verify [dir]\n" +
  "       afterpack restore [dir]\n" +
  "       afterpack audit <url>";

export const OUTPUT_DIR_LIST = OUTPUT_DIRS.map((dir) => `${dir}/`).join(", ");

const KEY_BY_PATH: ReadonlyMap<string, ConfigKeyDef> = new Map(
  CONFIG_KEYS.map((k) => [k.path, k as ConfigKeyDef]),
);

const COMMON_OPTION_PATHS = [
  "preset",
  "seed",
  "key",
  "diagnostics.format",
  "diagnostics.level",
  "paths.exclude",
] as const;

function commonOptionLines(): string {
  const rows = COMMON_OPTION_PATHS.map((path) => {
    const key = KEY_BY_PATH.get(path);
    if (!key) throw new Error(`no registry key at \`${path}\``);
    return [renderFlag(key), key.default] as const;
  });
  const width = Math.min(44, Math.max(...rows.map(([flag]) => flag.length)));
  return rows
    .map(([flag, def]) =>
      flag.length > width
        ? `  ${flag}\n  ${" ".repeat(width)}  default: ${def}`
        : `  ${flag.padEnd(width)}  default: ${def}`,
    )
    .join("\n");
}

export const HELP = `${USAGE}

AfterPack protects the JavaScript your build ships. Point it at your output
directory (dist/, build/, out/, ...) or at ONE .js/.mjs/.cjs file.

common options
${commonOptionLines()}

${dim("afterpack --help --all    every option")}
${dim("docs  https://www.afterpack.dev/docs/cli")}`;

const AREA_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["identifiers", "identifiers"],
  ["strings", "strings"],
  ["paths", "paths"],
  ["sourceMap", "source maps"],
  ["protectionMap", "protection map"],
  ["transforms", "transforms"],
  ["build", "build"],
  ["diagnostics", "diagnostics"],
  ["telemetry", "telemetry"],
];

function areaOf(path: string): string {
  const prefix = path.split(".")[0];
  return AREA_PREFIXES.find(([p]) => p === prefix)?.[1] ?? "engine";
}

const AREA_ORDER = [
  "engine",
  "identifiers",
  "strings",
  "paths",
  "source maps",
  "protection map",
  "transforms",
  "build",
  "diagnostics",
  "telemetry",
];

function optionLines(): string {
  const rows = CONFIG_KEYS.map((key) => [renderFlag(key as ConfigKeyDef), key.default] as const);
  const width = Math.min(52, Math.max(...rows.map(([flag]) => flag.length)));
  const byArea = new Map<string, string[]>();
  for (let i = 0; i < CONFIG_KEYS.length; i++) {
    const key = CONFIG_KEYS[i] as ConfigKeyDef;
    const [flag, def] = rows[i];
    const line =
      flag.length > width
        ? `  ${flag}\n  ${" ".repeat(width)}  default: ${def}`
        : `  ${flag.padEnd(width)}  default: ${def}`;
    const area = areaOf(key.path);
    const lines = byArea.get(area) ?? [];
    lines.push(line);
    byArea.set(area, lines);
  }
  return AREA_ORDER.filter((area) => byArea.has(area))
    .map((area) => byArea.get(area)?.join("\n"))
    .join("\n\n");
}

export const HELP_ALL = `${USAGE}

AfterPack protects the JavaScript your build ships. Point it at your output
directory (dist/, build/, out/, ...) or at ONE .js/.mjs/.cjs file, and
it processes every emitted file in place.

Every option below is written the same way in all four places: as
\`--key=value\` here, as AFTERPACK_<key with dots replaced by underscores> in
the environment, nested in afterpack.json (the nearest one at or above the
working directory), and — for the region-scoped keys — in an
\`/* @afterpack key=value */\` source directive. A boolean key written alone
means true; \`=false\` switches it off. Most specific wins: a directive, then a
flag, then the environment, then afterpack.json.

Arguments:
  [path]                   directory of emitted JS to obfuscate, or a single
                           .js/.mjs/.cjs file. A directory is walked
                           recursively; AfterPack's own .backup.<hash> copies
                           are never re-obfuscated. OMIT IT and afterpack picks
                           your build output itself: the directory your bundler
                           writes, else the newest of
                           ${OUTPUT_DIR_LIST}. It never prompts, and exits 1
                           when it finds none.

Commands:
  verify [dir]             re-check a build output tree against the protection
                           receipt the build wrote into it (defaults to the
                           working directory; a project root and its .next/ both
                           work). Exits nonzero when the receipt is missing, is
                           from a different build, or any recorded file no longer
                           hashes to the value it was obfuscated to. Run it in
                           the deploy step. \`afterpack verify --help\` for more.
  restore [dir]            undo a run in place: restores the original files a
                           previous run backed up to .afterpack/backup/ (defaults
                           to the working directory). Refuses a file whose current
                           bytes no longer match what that run obfuscated it to,
                           and refuses outright with no backup manifest.
                           \`afterpack restore --help\` for more.
  audit <url>              scan a DEPLOYED site for leaked secrets, exposed
                           source and unprotected JavaScript, streaming the
                           findings as they land. \`afterpack audit --help\`.

Options:
${optionLines()}

  paths.include is the CLI's DISK WALK only: it re-admits what the walk skips,
  so \`--paths.include='**/node_modules/**'\` walks nested node_modules too.
  Quote the glob or the shell expands it first. In a bundled build
  (Vite/Next/webpack) vendor code is already inlined into the
  chunks with no node_modules path left to match, so an engine-level setting
  would be a silent no-op that reads as protection you do not have.
  paths.exclude is the engine-side carve-out and applies everywhere.

  diagnostics.format=json prints ONE JSON document on stdout and moves every
  human line to stderr — the shape agents and CI steps should read.
  diagnostics.level=none drops the progress and summary lines; errors still print.

${EXIT_CODE_HELP}

Telemetry: only on a build that reports an error-level diagnostic (a refused
or partial build), never on a clean build. See https://www.afterpack.dev/privacy

${dim(CONTACT_FOOTER)}`;
