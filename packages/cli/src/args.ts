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

export const USAGE =
  "usage: afterpack [path] [--key=value ...] [--help] [--version]\n" +
  "       afterpack verify [dir]\n" +
  "       afterpack audit <url>";

const OUTPUT_DIR_LIST = OUTPUT_DIRS.map((dir) => `${dir}/`).join(", ");

export const QUICKSTART = `${USAGE}

afterpack obfuscates the JavaScript a build already emitted.

  1. build your project first — afterpack never runs it for you
  2. run \`npx afterpack@latest\` in the project root, or name the directory:
     \`npx afterpack@latest dist/\`
  3. deploy the output; \`npx afterpack@latest verify\` re-checks it first

Nothing to obfuscate was found here: none of ${OUTPUT_DIR_LIST} exists in the
working directory. Build, then run it again — or pass the path yourself.

Run \`afterpack --help\` for every option, or see https://www.afterpack.dev/docs/cli`;

function optionLines(): string {
  const rows = CONFIG_KEYS.map((key) => [renderFlag(key as ConfigKeyDef), key.default] as const);
  const width = Math.min(52, Math.max(...rows.map(([flag]) => flag.length)));
  return rows
    .map(([flag, def]) =>
      flag.length > width
        ? `  ${flag}\n  ${" ".repeat(width)}  default: ${def}`
        : `  ${flag.padEnd(width)}  default: ${def}`,
    )
    .join("\n");
}

export const HELP = `${USAGE}

afterpack obfuscates the JavaScript a build already emitted. Point it at your
output directory (dist/, build/, out/, ...) or at ONE .js/.mjs/.cjs file, and
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

Telemetry reports ONLY when a build FAILS: the diagnostic code, severity, byte
offsets and typed engine fields, plus versions, OS/arch and bucketed counts.
Never your source, file names, paths or message text. Turn it off with
\`--telemetry.enabled=false\`. See https://www.afterpack.dev/privacy`;
