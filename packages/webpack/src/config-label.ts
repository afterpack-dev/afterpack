import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathBundleLabel } from "@afterpack/integration-utils";

const WEBPACK_CLI_BIN_RE =
  /[\\/](?:webpack-cli[\\/].+|webpack[\\/]bin[\\/]webpack(?:\.js)?|\.bin[\\/]webpack(?:\.cmd)?)$/;

const DEFAULT_CONFIG_NAMES = ["webpack.config", join(".webpack", "webpack.config")];
const DEFAULT_CONFIG_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"];

function explicitConfigFiles(args: readonly string[]): string[] {
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const inline = /^(?:--config|-c)=(.+)$/.exec(arg);
    if (inline) files.push(inline[1]);
    else if ((arg === "--config" || arg === "-c") && args[i + 1] && !args[i + 1].startsWith("-")) {
      files.push(args[++i]);
    }
  }
  return files;
}

function defaultConfigFile(cwd: string): string | undefined {
  for (const name of DEFAULT_CONFIG_NAMES) {
    for (const extension of DEFAULT_CONFIG_EXTENSIONS) {
      const candidate = join(cwd, `${name}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export function webpackConfigFileLabel(
  argv: readonly string[],
  cwd: string,
  root: string,
): string | undefined {
  if (!WEBPACK_CLI_BIN_RE.test(argv[1] ?? "")) return undefined;
  const explicit = explicitConfigFiles(argv.slice(2)).map((file) => resolve(cwd, file));
  const files = explicit.length > 0 ? explicit : [defaultConfigFile(cwd)];
  const labels = files.flatMap((file) => {
    const label = file && pathBundleLabel(file, root);
    return label ? [label] : [];
  });
  return labels.length > 0 ? labels.join(" + ") : undefined;
}
