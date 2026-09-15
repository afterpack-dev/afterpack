import { readFileSync } from "node:fs";
import { findUpward } from "./paths.js";
import {
  type AfterpackConfig,
  type ConfigIssue,
  EMPTY_CONFIG,
  validateConfig,
} from "./registry.js";

export const CONFIG_FILE_NAME = "afterpack.json";

function findConfigFile(startDir: string): string | null {
  return findUpward(startDir, CONFIG_FILE_NAME);
}

export interface LoadedConfigFile {
  path: string | null;
  config: AfterpackConfig;
  issues: ConfigIssue[];
}

export function loadConfigFile(startDir: string): LoadedConfigFile {
  const path = findConfigFile(startDir);
  if (!path) return { path: null, config: EMPTY_CONFIG, issues: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      path,
      config: EMPTY_CONFIG,
      issues: [{ path: CONFIG_FILE_NAME, message: `${path} is not valid JSON: ${detail}` }],
    };
  }
  const { config, issues } = validateConfig(raw, path);
  return { path, config, issues };
}
