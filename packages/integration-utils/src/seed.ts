import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

export type SeedOption = number | string | undefined;

export function randomSeed(): number {
  const b = randomBytes(8);
  const hi = b.readUInt32BE(0) & 0x1f_ffff;
  const lo = b.readUInt32BE(4);
  return hi * 0x1_0000_0000 + lo;
}

export function gitHead(): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "HEAD"], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return /^[0-9a-f]{7,64}$/i.test(out) ? out : null;
  } catch {
    return null;
  }
}

export const SEED_ENV_VAR = "AFTERPACK_SEED";

export type SeedOrigin = "option" | "git" | "env" | "session" | "fresh";

interface BuildSeedScope {
  root: string;
  leg: string;
}

interface ResolvedBuildSeed {
  seed: number | string;
  origin: SeedOrigin;
  legs: string[];
  generation: number;
  mismatch: { leg: string; seed: number | string } | null;
}

interface ResolveBuildSeedDeps {
  gitHead?: () => string | null;
  randomSeed?: () => number;
  warn?: (message: string) => void;
  env?: Record<string, string | undefined>;
  exportToEnv?: boolean;
}

export function parseSeedValue(raw: string): number | string {
  return /^-?\d+$/.test(raw) ? Number(raw) : raw;
}

interface BuildSession {
  seed: number | string | undefined;
  generation: number;
  legs: string[];
  resolvedByLeg: Map<string, number | string>;
  gitFallbackWarned: boolean;
}

const sessions = new Map<string, BuildSession>();
const ownEnvExports: { env: Record<string, string | undefined>; value: string }[] = [];

export function resetBuildSessions(): void {
  sessions.clear();
  for (const e of ownEnvExports) {
    if (e.env[SEED_ENV_VAR] === e.value) delete e.env[SEED_ENV_VAR];
  }
  ownEnvExports.length = 0;
}

function isOwnEnvExport(env: Record<string, string | undefined>, value: string): boolean {
  return ownEnvExports.some((e) => e.env === env && e.value === value);
}

function openGeneration(root: string, leg: string): BuildSession {
  let session = sessions.get(root);
  if (!session) {
    session = {
      seed: undefined,
      generation: 1,
      legs: [],
      resolvedByLeg: new Map(),
      gitFallbackWarned: false,
    };
    sessions.set(root, session);
  } else if (session.legs.includes(leg)) {
    session.seed = undefined;
    session.generation += 1;
    session.legs = [];
    session.resolvedByLeg.clear();
    session.gitFallbackWarned = false;
  }
  session.legs.push(leg);
  return session;
}

function resolveWithinSession(
  input: SeedOption,
  session: BuildSession,
  env: Record<string, string | undefined>,
  deps: ResolveBuildSeedDeps,
): { seed: number | string; origin: SeedOrigin } {
  if (typeof input === "number") return { seed: input, origin: "option" };
  if (typeof input === "string" && input !== "git") return { seed: input, origin: "option" };
  if (input === "git") {
    const head = (deps.gitHead ?? gitHead)();
    if (head) return { seed: head, origin: "git" };
    if (!session.gitFallbackWarned) {
      session.gitFallbackWarned = true;
      (deps.warn ?? ((m: string) => console.warn(m)))(
        '[afterpack] seed "git": no git repository / HEAD found; ' +
          "using a fresh random seed for this build.",
      );
    }
  }
  const fromEnv = env[SEED_ENV_VAR];
  if (fromEnv != null && fromEnv !== "" && !isOwnEnvExport(env, fromEnv)) {
    return { seed: parseSeedValue(fromEnv), origin: "env" };
  }
  if (session.seed !== undefined) return { seed: session.seed, origin: "session" };
  return { seed: (deps.randomSeed ?? randomSeed)(), origin: "fresh" };
}

export function resolveBuildSeed(
  input: SeedOption,
  scope: BuildSeedScope,
  deps: ResolveBuildSeedDeps = {},
): ResolvedBuildSeed {
  const env = deps.env ?? (process.env as Record<string, string | undefined>);
  const session = openGeneration(scope.root, scope.leg);
  const { seed, origin } = resolveWithinSession(input, session, env, deps);

  if (origin === "env" || origin === "fresh") session.seed = seed;
  if (origin === "fresh" && (deps.exportToEnv ?? true)) {
    const value = String(seed);
    env[SEED_ENV_VAR] = value;
    const stale = ownEnvExports.findIndex((e) => e.env === env);
    if (stale >= 0) ownEnvExports.splice(stale, 1);
    ownEnvExports.push({ env, value });
  }

  const prior = [...session.resolvedByLeg].find(([, s]) => s !== seed);
  session.resolvedByLeg.set(scope.leg, seed);

  return {
    seed,
    origin,
    legs: [...session.legs],
    generation: session.generation,
    mismatch: prior && session.generation === 1 ? { leg: prior[0], seed: prior[1] } : null,
  };
}
