import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SEED_ENV_VAR } from "@afterpack/integration-utils";

const PACKAGER_CONFIGS = [
  "electron-builder.yml",
  "electron-builder.yaml",
  "electron-builder.json",
  "electron-builder.json5",
  "electron-builder.toml",
  "electron-builder.config.js",
  "electron-builder.config.cjs",
  "electron-builder.config.mjs",
  "electron-builder.config.ts",
  "forge.config.js",
  "forge.config.cjs",
  "forge.config.mjs",
  "forge.config.ts",
];

const seenLegs = new Set<string>();
let leakWarned = false;
let advisoryArmed = false;
let envSeedPinned: boolean | undefined;

export function resetNotices(): void {
  seenLegs.clear();
  leakWarned = false;
  advisoryArmed = false;
  envSeedPinned = undefined;
}

export function recordEnvSeedPinned(): void {
  envSeedPinned ??= process.env[SEED_ENV_VAR] != null;
}

function hasPackagerConfig(root: string): boolean {
  if (PACKAGER_CONFIGS.some((name) => existsSync(join(root, name)))) return true;
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      build?: unknown;
      config?: { forge?: unknown };
    };
    return pkg.build != null || pkg.config?.forge != null;
  } catch {
    return false;
  }
}

export function warnPackagedTreeLeak(root: string, warn: (m: string) => void): void {
  if (leakWarned || !hasPackagerConfig(root)) return;
  leakWarned = true;
  warn(
    "[afterpack-electron] this project has an Electron packager config. AfterPack's " +
      "artifacts embed ORIGINAL SOURCE and are NOT excluded by default — add\n" +
      '  electron-builder: "files": ["**/*", "!.afterpack/**", "!**/*.backup.*", "!**/*.map"]\n' +
      "  electron-forge:   packagerConfig.ignore: [/^\\/\\.afterpack/, /\\.backup\\./, /\\.map$/]\n" +
      "or they ship inside app.asar.",
  );
}

export function recordLegBuilt(leg: string, seedPinned: boolean): void {
  seenLegs.add(leg);
  if (advisoryArmed || seedPinned || envSeedPinned) return;
  advisoryArmed = true;
  process.on("exit", () => {
    if (seenLegs.size > 1) return;
    console.warn(
      `[afterpack-electron] only the "${[...seenLegs][0]}" leg was obfuscated in this ` +
        `process, so the other legs drew their own seeds. Set ${SEED_ENV_VAR}=git (or a ` +
        "pinned value) once in the shared build script so every leg shares one.",
    );
  });
}
