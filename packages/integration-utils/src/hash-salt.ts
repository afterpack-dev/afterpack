import { createHash, randomUUID } from "node:crypto";
import type { PassSettings } from "./plugin-config.js";
import { resolveReportPolicy } from "./policy.js";
import { type ResolvedBuildSeed, resolveBuildSeed, type SeedOption } from "./seed.js";
import { DEFAULT_API_URL } from "./telemetry.js";

const API_URL_ENV_VAR = "AFTERPACK_API_URL";
const VERSION_ENDPOINT_PATH = "/v1/version";
const VERSION_PROBE_TIMEOUT_MS = 2000;

export interface SaltEngine {
  engineVersion: string | null;
  nonce: string | null;
  cloud: boolean;
  probedCloudVersion: string | null;
  probeFailed: boolean;
}

export interface HashSaltInput {
  seed: number | string;
  engine: SaltEngine;
  settings: unknown;
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
      engineVersion: input.engine.engineVersion,
      nonce: input.engine.nonce,
      cloud: input.engine.cloud,
      settings: input.settings,
    }),
  );
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

export function isCloudBuild(env: Record<string, string | undefined>): boolean {
  const key = env.AFTERPACK_KEY;
  return typeof key === "string" && key.trim() !== "";
}

export function versionEndpoint(env: Record<string, string | undefined>): string {
  const base = (env[API_URL_ENV_VAR] ?? DEFAULT_API_URL).replace(/\/+$/, "");
  return `${base}${VERSION_ENDPOINT_PATH}`;
}

export interface ResolveSaltEngineDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function resolveSaltEngine(
  env: Record<string, string | undefined>,
  localEngineVersion: string | null,
  deps: ResolveSaltEngineDeps = {},
): Promise<SaltEngine> {
  if (!isCloudBuild(env)) {
    return {
      engineVersion: localEngineVersion,
      nonce: null,
      cloud: false,
      probedCloudVersion: null,
      probeFailed: false,
    };
  }
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  let probed: string | null = null;
  if (typeof fetchImpl === "function") {
    try {
      const response = await fetchImpl(versionEndpoint(env), {
        signal: AbortSignal.timeout(deps.timeoutMs ?? VERSION_PROBE_TIMEOUT_MS),
      });
      if (response.ok) {
        const body = (await response.json()) as { engineVersion?: unknown };
        if (typeof body.engineVersion === "string" && body.engineVersion !== "") {
          probed = body.engineVersion;
        }
      }
    } catch {
      probed = null;
    }
  }
  if (probed === null) {
    return {
      engineVersion: null,
      nonce: randomUUID(),
      cloud: true,
      probedCloudVersion: null,
      probeFailed: true,
    };
  }
  return {
    engineVersion: probed,
    nonce: null,
    cloud: true,
    probedCloudVersion: probed,
    probeFailed: false,
  };
}

export const PROBE_FAILED_WARNING =
  "could not read the cloud engine version from the API, so output file names carry a random " +
  "nonce this build only. They are safe, but a pinned seed will not reproduce them. Re-run when " +
  "the API is reachable to get stable names.";

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

export interface ReportPolicySaltBits {
  sourceMap: boolean;
  emitSourceMappingURL: boolean;
}

export function reportPolicySaltBits(
  env: Record<string, string | undefined>,
  artifactOptions: PassSettings["artifactOptions"],
  hasBundlerSourcemap: boolean,
): ReportPolicySaltBits {
  const policy = resolveReportPolicy(env, artifactOptions ?? {}, { hasBundlerSourcemap });
  return { sourceMap: policy.sourceMap, emitSourceMappingURL: policy.emitSourceMappingURL };
}

export interface PreparedHashSalt {
  salt: string;
  resolvedSeed: ResolvedBuildSeed;
  engine: SaltEngine;
}

export interface PrepareHashSaltInput {
  seed: SeedOption;
  root: string;
  leg: string;
  localEngineVersion: string | null;
  settings: unknown;
  env?: Record<string, string | undefined>;
  warn?: (message: string) => void;
  fetchImpl?: typeof fetch;
}

export async function prepareHashSalt(input: PrepareHashSaltInput): Promise<PreparedHashSalt> {
  const env = input.env ?? (process.env as Record<string, string | undefined>);
  const resolvedSeed = resolveBuildSeed(
    input.seed,
    { root: input.root, leg: input.leg },
    { env, warn: input.warn },
  );
  const engine = await resolveSaltEngine(env, input.localEngineVersion, {
    fetchImpl: input.fetchImpl,
  });
  if (engine.probeFailed) input.warn?.(PROBE_FAILED_WARNING);
  return {
    resolvedSeed,
    engine,
    salt: afterpackHashSalt({ seed: resolvedSeed.seed, engine, settings: input.settings }),
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

export function cloudEngineMismatch(
  engine: SaltEngine,
  batchEngineVersion: string | null,
): string | null {
  if (!engine.cloud || engine.probedCloudVersion === null) return null;
  if (batchEngineVersion === null) return null;
  if (batchEngineVersion === engine.probedCloudVersion) return null;
  return (
    `the cloud engine was version ${engine.probedCloudVersion} when output names were derived, ` +
    `but the build ran on ${batchEngineVersion}. Names would not match the bytes. This is a rare ` +
    "race during a service upgrade — re-run the build."
  );
}
