import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const BROWSERS = ["chromium", "firefox", "webkit"] as const;
export type BrowserName = (typeof BROWSERS)[number];

export interface FixtureTarget {
  label: string;
  path: string;
}

export interface BaselineServer {
  env: Record<string, string>;
  buildCommand: string;
  serveCommand: string;
  port: number;
  baseURL: string;
  buildLog: string;
  receipts: string[];
}

export interface Fixture {
  name: string;
  relativeDir: string;
  dir: string;
  buildCommand: string;
  clean: string[];
  env: Record<string, string>;
  targets: FixtureTarget[];
  receipts: string[];
  port: number | null;
  serveCommand: string | null;
  baseURL: string | null;
  buildLog: string;
  baseline: BaselineServer | null;
  weight: number;
}

interface FixtureSpec {
  name: string;
  dir: string;
  build: string;
  clean?: string[];
  env?: Record<string, string>;
  targets: Record<string, string>;
  receipts?: string[];
  port?: number;
  serve?: string;
  baseline?: {
    env?: Record<string, string>;
    build?: string;
    serve?: string;
    receipts: string[];
  };
  weight: number;
}

const BASELINE_PORT_OFFSET = 100;

const SPECS: FixtureSpec[] = [
  {
    name: "vite-react",
    dir: "packages/vite/e2e/react",
    build: "npm run build",
    targets: { root: "dist" },
    port: 4301,
    serve: "npx vite preview --port {port} --strictPort",
    baseline: {
      build: "npm run build -- --outDir dist-baseline --emptyOutDir",
      serve: "npx vite preview --port {port} --strictPort --outDir dist-baseline",
      receipts: ["dist-baseline"],
    },
    weight: 30,
  },
  {
    name: "webpack-react",
    dir: "packages/webpack/e2e/react",
    build: "npm run build",
    clean: ["dist"],
    targets: { root: "dist" },
    port: 4302,
    serve: "node serve.mjs {port}",
    weight: 10,
  },
  {
    name: "rollup-lib",
    dir: "packages/rollup/e2e/lib",
    build: "npm run build",
    targets: { root: "dist" },
    receipts: ["dist/esm", "dist/cjs"],
    port: 4303,
    serve: "node serve.mjs {port}",
    weight: 5,
  },
  {
    name: "esbuild-app",
    dir: "packages/esbuild/e2e/app",
    build: "npm run build",
    targets: { root: "dist" },
    port: 4304,
    serve: "node serve.mjs {port}",
    weight: 5,
  },
  {
    name: "astro-islands",
    dir: "packages/astro/e2e/islands",
    build: "npm run build",
    targets: { root: "dist" },
    port: 4305,
    serve: "npx astro preview --port {port}",
    weight: 15,
  },
  {
    name: "svelte-app",
    dir: "packages/svelte/e2e/app",
    build: "npm run build",
    targets: { root: "dist" },
    port: 4306,
    serve: "npx vite preview --port {port} --strictPort",
    weight: 8,
  },
  {
    name: "sveltekit-app",
    dir: "packages/sveltekit/e2e/app",
    build: "npm run build",
    targets: { root: "build" },
    receipts: ["build", ".svelte-kit/output/server"],
    port: 4307,
    serve: "node serve.mjs {port}",
    weight: 15,
  },
  {
    name: "vue-vite",
    dir: "packages/vue/e2e/vite",
    build: "npm run build",
    targets: { root: "dist" },
    port: 4308,
    serve: "npx vite preview --port {port} --strictPort",
    weight: 8,
  },
  {
    name: "nuxt-app",
    dir: "packages/nuxt/e2e/app",
    build: "npm run build",
    targets: { root: ".output/public/_nuxt" },
    receipts: [".nuxt/dist/client", ".nuxt/dist/server"],
    port: 4309,
    serve: "node serve.mjs {port}",
    weight: 25,
  },
  {
    name: "angular-app",
    dir: "packages/angular/e2e/app",
    build: "npm run build",
    targets: { root: "dist/angular-fixture/browser" },
    port: 4310,
    serve: "node serve.mjs {port}",
    weight: 25,
  },
  {
    name: "parcel-app",
    dir: "packages/parcel/e2e/app",
    build: "npm run build",
    clean: [".parcel-cache", "dist"],
    env: { COLUMNS: "1000", LINES: "50" },
    targets: { root: "dist" },
    receipts: [],
    port: 4311,
    serve: "node serve.mjs {port}",
    weight: 15,
  },
  {
    name: "electron-app",
    dir: "packages/electron/e2e/app",
    build: "npm run build",
    targets: { main: "out/main", preload: "out/preload", renderer: "out/renderer" },
    port: 4312,
    serve: "node harness/serve-renderer.mjs out/renderer {port}",
    weight: 20,
  },
  {
    name: "cli-vanilla-esm",
    dir: "packages/cli/e2e/vanilla-esm",
    build: "npm run build",
    targets: { root: "dist" },
    port: 4313,
    serve: "node serve.mjs {port}",
    weight: 3,
  },
  {
    name: "cli-requirejs-amd",
    dir: "packages/cli/e2e/requirejs-amd",
    build: "npm run build",
    targets: { root: "dist/modules" },
    port: 4314,
    serve: "node serve.mjs {port}",
    weight: 3,
  },
  {
    name: "cli-single-file",
    dir: "packages/cli/e2e/single-file",
    build: "npm run build",
    targets: { root: "dist" },
    weight: 3,
  },
  {
    name: "next-app-turbopack",
    dir: "packages/next/e2e/app",
    build: "npm run build",
    env: { AFTERPACK_E2E_DIST_DIR: ".next" },
    targets: { client: ".next/static/chunks", server: ".next/server" },
    receipts: [".next"],
    port: 4315,
    serve: "npx next start --port {port}",
    baseline: { env: { AFTERPACK_E2E_DIST_DIR: ".next-baseline" }, receipts: [".next-baseline"] },
    weight: 60,
  },
  {
    name: "next-app-webpack",
    dir: "packages/next/e2e/app",
    build: "npm run build:webpack",
    env: { AFTERPACK_E2E_DIST_DIR: ".next-webpack" },
    targets: { client: ".next-webpack/static/chunks", server: ".next-webpack/server" },
    receipts: [".next-webpack"],
    port: 4316,
    serve: "npx next start --port {port}",
    baseline: {
      env: { AFTERPACK_E2E_DIST_DIR: ".next-webpack-baseline" },
      receipts: [".next-webpack-baseline"],
    },
    weight: 70,
  },
  {
    name: "next-pages-turbopack",
    dir: "packages/next/e2e/pages",
    build: "npm run build",
    env: { AFTERPACK_E2E_DIST_DIR: ".next" },
    targets: { client: ".next/static/chunks", server: ".next/server" },
    receipts: [".next"],
    port: 4317,
    serve: "npx next start --port {port}",
    weight: 30,
  },
  {
    name: "next-pages-webpack",
    dir: "packages/next/e2e/pages",
    build: "npm run build:webpack",
    env: { AFTERPACK_E2E_DIST_DIR: ".next-webpack" },
    targets: { client: ".next-webpack/static/chunks", server: ".next-webpack/server" },
    receipts: [".next-webpack"],
    port: 4318,
    serve: "npx next start --port {port}",
    weight: 30,
  },
  {
    name: "next-static-export",
    dir: "packages/next/e2e/static-export",
    build: "npm run build",
    env: { AFTERPACK_E2E_DIST_DIR: ".next" },
    targets: { out: "out" },
    receipts: [".next"],
    port: 4319,
    serve: "npx serve out -p {port} -L",
    weight: 30,
  },
];

function withPort(command: string, port: number): string {
  return command.replaceAll("{port}", String(port));
}

function toFixture(spec: FixtureSpec): Fixture {
  const dir = join(REPO_ROOT, spec.dir);
  const port = spec.port ?? null;
  const buildLog = join(dir, ".afterpack", `e2e-build-${spec.name}.log`);
  const targets = Object.entries(spec.targets).map(([label, path]) => ({
    label,
    path: join(dir, path),
  }));
  let baseline: BaselineServer | null = null;
  if (spec.baseline && spec.serve && port) {
    const baselinePort = port + BASELINE_PORT_OFFSET;
    baseline = {
      env: { ...spec.env, ...spec.baseline.env, AFTERPACK_build_autorun: "false" },
      buildCommand: spec.baseline.build ?? spec.build,
      serveCommand: withPort(spec.baseline.serve ?? spec.serve, baselinePort),
      port: baselinePort,
      baseURL: `http://localhost:${baselinePort}`,
      buildLog: `${buildLog}.baseline`,
      receipts: spec.baseline.receipts.map((path) => join(dir, path)),
    };
  }
  return {
    name: spec.name,
    relativeDir: spec.dir,
    dir,
    buildCommand: spec.build,
    clean: (spec.clean ?? []).map((path) => join(dir, path)),
    env: spec.env ?? {},
    targets,
    receipts: spec.receipts
      ? spec.receipts.map((path) => join(dir, path))
      : targets.map((target) => target.path),
    port,
    serveCommand: spec.serve && port ? withPort(spec.serve, port) : null,
    baseURL: port ? `http://localhost:${port}` : null,
    buildLog,
    baseline,
    weight: spec.weight,
  };
}

export const FIXTURES: Fixture[] = SPECS.map(toFixture);

export function fixture(name: string): Fixture {
  const found = FIXTURES.find((f) => f.name === name);
  if (!found) throw new Error(`no e2e fixture named "${name}"`);
  return found;
}

function groupsByDir(fixtures: Fixture[]): Fixture[][] {
  const groups = new Map<string, Fixture[]>();
  for (const f of fixtures) groups.set(f.dir, [...(groups.get(f.dir) ?? []), f]);
  return [...groups.values()];
}

export function shardOf(fixtures: Fixture[], index: number, total: number): Fixture[] {
  const load = Array.from({ length: total }, () => 0);
  const members: Fixture[][] = Array.from({ length: total }, () => []);
  const weightOf = (group: Fixture[]) => group.reduce((sum, f) => sum + f.weight, 0);
  const groups = groupsByDir(fixtures).sort(
    (a, b) => weightOf(b) - weightOf(a) || a[0].name.localeCompare(b[0].name),
  );
  for (const group of groups) {
    const lightest = load.indexOf(Math.min(...load));
    load[lightest] += weightOf(group);
    members[lightest].push(...group);
  }
  const chosen = new Set(members[index - 1]);
  return fixtures.filter((f) => chosen.has(f));
}

function parseShard(value: string): { index: number; total: number } {
  const match = /^(\d+)\/(\d+)$/.exec(value);
  const index = match ? Number(match[1]) : 0;
  const total = match ? Number(match[2]) : 0;
  if (!match || total < 1 || index < 1 || index > total) {
    throw new Error(`AFTERPACK_E2E_SHARD must look like 2/4, got "${value}"`);
  }
  return { index, total };
}

export function selectedFixtures(env: NodeJS.ProcessEnv = process.env): Fixture[] {
  const names = (env.AFTERPACK_E2E_FIXTURES ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  let chosen = names.length > 0 ? names.map(fixture) : FIXTURES;
  if (env.AFTERPACK_E2E_SHARD) {
    const { index, total } = parseShard(env.AFTERPACK_E2E_SHARD);
    chosen = shardOf(chosen, index, total);
  }
  return chosen;
}

export function selectedBrowsers(env: NodeJS.ProcessEnv = process.env): BrowserName[] {
  const names = (env.AFTERPACK_E2E_BROWSERS ?? "chromium")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  for (const name of names) {
    if (!(BROWSERS as readonly string[]).includes(name)) {
      throw new Error(`AFTERPACK_E2E_BROWSERS names an unknown browser "${name}"`);
    }
  }
  if (names.length === 0) throw new Error("AFTERPACK_E2E_BROWSERS names no browser");
  return [...new Set(names)] as BrowserName[];
}

function requestedCount(value: string | undefined): number | null {
  const count = Number(value);
  return Number.isInteger(count) && count >= 1 ? count : null;
}

function onSelfHostedRunner(env: NodeJS.ProcessEnv): boolean {
  return env.RUNNER_ENVIRONMENT === "self-hosted";
}

export function buildConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const requested = requestedCount(env.AFTERPACK_E2E_BUILD_CONCURRENCY);
  if (requested !== null) return requested;
  if (onSelfHostedRunner(env)) return 1;
  return Math.max(1, Math.min(3, availableParallelism() - 1));
}

export function playwrightWorkers(env: NodeJS.ProcessEnv = process.env): number {
  return requestedCount(env.AFTERPACK_E2E_WORKERS) ?? (onSelfHostedRunner(env) ? 1 : 2);
}

export function fixtureDirs(fixtures: Fixture[] = FIXTURES): string[] {
  return [...new Set(fixtures.map((f) => f.dir))].sort();
}

export function baseURLOf(target: Fixture): string {
  if (!target.baseURL) throw new Error(`e2e fixture "${target.name}" serves no browser surface`);
  return target.baseURL;
}
