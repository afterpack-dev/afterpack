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

interface NoticeState {
  seenLegs: Set<string>;
  leakWarned: boolean;
  advisoryArmed: boolean;
  envSeedPinned: boolean | undefined;
}

const NOTICE_STATE = Symbol.for("afterpack.electron.notices");

function sharedNoticeState(): NoticeState {
  const holder = globalThis as { [NOTICE_STATE]?: NoticeState };
  holder[NOTICE_STATE] ??= {
    seenLegs: new Set(),
    leakWarned: false,
    advisoryArmed: false,
    envSeedPinned: undefined,
  };
  return holder[NOTICE_STATE];
}

const state = sharedNoticeState();

export function resetNotices(): void {
  state.seenLegs.clear();
  state.leakWarned = false;
  state.advisoryArmed = false;
  state.envSeedPinned = undefined;
}

export function recordEnvSeedPinned(): void {
  state.envSeedPinned ??= process.env[SEED_ENV_VAR] != null;
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
  if (state.leakWarned || !hasPackagerConfig(root)) return;
  state.leakWarned = true;
  warn(
    "[afterpack-electron] this project has an Electron packager config. AfterPack's " +
      "artifacts embed ORIGINAL SOURCE and are NOT excluded by default — add\n" +
      '  electron-builder: "files": ["**/*", "!.afterpack/**", "!**/*.backup.*", "!**/*.map"]\n' +
      "  electron-forge:   packagerConfig.ignore: [/^\\/\\.afterpack/, /\\.backup\\./, /\\.map$/]\n" +
      "or they ship inside app.asar.",
  );
}

export function recordLegBuilt(leg: string, seedPinned: boolean): void {
  state.seenLegs.add(leg);
  if (state.advisoryArmed || seedPinned || state.envSeedPinned) return;
  state.advisoryArmed = true;
  process.on("exit", () => {
    if (state.seenLegs.size > 1) return;
    console.warn(
      `[afterpack-electron] only the "${[...state.seenLegs][0]}" leg was obfuscated in this ` +
        `process, so the other legs drew their own seeds. Set ${SEED_ENV_VAR}=git (or a ` +
        "pinned value) once in the shared build script so every leg shares one.",
    );
  });
}
