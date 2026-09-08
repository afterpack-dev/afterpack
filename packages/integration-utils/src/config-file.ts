import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type AfterpackConfig, type ConfigIssue, validateConfig } from "./registry.js";

export const CONFIG_FILE_NAME = "afterpack.json";

export function findConfigFile(startDir: string): string | null {
  let current = resolve(startDir);
  for (;;) {
    const candidate = join(current, CONFIG_FILE_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export interface LoadedConfigFile {
  path: string | null;
  config: AfterpackConfig;
  issues: ConfigIssue[];
}

export function loadConfigFile(startDir: string): LoadedConfigFile {
  const path = findConfigFile(startDir);
  if (!path) return { path: null, config: {} as AfterpackConfig, issues: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      path,
      config: {} as AfterpackConfig,
      issues: [{ path: CONFIG_FILE_NAME, message: `${path} is not valid JSON: ${detail}` }],
    };
  }
  const { config, issues } = validateConfig(raw, path);
  return { path, config, issues };
}
