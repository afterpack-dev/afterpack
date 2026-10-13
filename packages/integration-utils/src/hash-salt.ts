import { createHash } from "node:crypto";
import type { PassSettings } from "./plugin-config.js";
import { type ResolvedBuildSeed, resolveBuildSeed, type SeedOption } from "./seed.js";

export interface HashSaltInput {
  seed: number | string;
  engineVersion: string | null;
  settings: unknown;
  cloud: boolean;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) out[key] = canonical(item);
  }
  return out;
}

export function afterpackHashSalt(input: HashSaltInput): string {
  const payload = JSON.stringify(
    canonical({
      salt: "afterpack-output-name/1",
      seed: String(input.seed),
      engineVersion: input.engineVersion,
      settings: input.settings,
      cloud: input.cloud,
    }),
  );
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

export function isCloudBuild(env: Record<string, string | undefined>): boolean {
  const key = env.AFTERPACK_KEY;
  return typeof key === "string" && key.trim() !== "";
}

export function saltSettings(settings: PassSettings, extra: Record<string, unknown> = {}): unknown {
  const {
    seed: _seed,
    diagnostics: _diagnostics,
    artifactOptions,
    engineConfig,
    ...rest
  } = settings;
  const { git: _git, telemetry: _telemetry, ...output } = artifactOptions ?? {};
  const { seed: _engineSeed, ...engine } = (engineConfig ?? {}) as Record<string, unknown>;
  return { ...rest, engineConfig: engine, artifactOptions: output, ...extra };
}

export interface PreparedHashSalt {
  salt: string;
  resolvedSeed: ResolvedBuildSeed;
}

export interface PrepareHashSaltInput {
  seed: SeedOption;
  root: string;
  leg: string;
  engineVersion: string | null;
  settings: unknown;
  env?: Record<string, string | undefined>;
  warn?: (message: string) => void;
}

export function prepareHashSalt(input: PrepareHashSaltInput): PreparedHashSalt {
  const env = input.env ?? (process.env as Record<string, string | undefined>);
  const resolvedSeed = resolveBuildSeed(
    input.seed,
    { root: input.root, leg: input.leg },
    { env, warn: input.warn },
  );
  return {
    resolvedSeed,
    salt: afterpackHashSalt({
      seed: resolvedSeed.seed,
      engineVersion: input.engineVersion,
      settings: input.settings,
      cloud: isCloudBuild(env),
    }),
  };
}

export async function readEngineVersion(engine: {
  version?(): Promise<string>;
}): Promise<string | null> {
  try {
    return (await engine.version?.()) ?? null;
  } catch {
    return null;
  }
}
