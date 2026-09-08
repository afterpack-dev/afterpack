import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface FixtureTarget {
  label: string;
  path: string;
}

export interface Fixture {
  name: string;
  relativeDir: string;
  dir: string;
  buildCommand: string;
  env: Record<string, string>;
  targets: FixtureTarget[];
  port: number | null;
  serveCommand: string | null;
  baseURL: string | null;
  buildLog: string;
}

interface FixtureSpec {
  name: string;
  dir: string;
  build: string;
  env?: Record<string, string>;
  targets: Record<string, string>;
  port?: number;
  serve?: string;
}

const SPECS: FixtureSpec[] = [
  {
    name: "vite-react",
    dir: "packages/vite/e2e/react",
    build: "npm run build",
    targets: { root: "dist" },
    port: 4301,
    serve: "npx vite preview --port {port} --strictPort",
  },
  {
    name: "webpack-react",
    dir: "packages/webpack/e2e/react",
    build: "rm -rf dist && npm run build",
    targets: { root: "dist" },
    port: 4302,
    serve: "node serve.mjs {port}",
  },
  {
    name: "rollup-lib",
    dir: "packages/rollup/e2e/lib",
    build: "npm run build",
    targets: { root: "dist" },
    port: 4303,
    serve: "node serve.mjs {port}",
  },
  {
    name: "esbuild-app",
    dir: "packages/esbuild/e2e/app",
    build: "npm run build",
    targets: { root: "dist" },
    port: 4304,
    serve: "node serve.mjs {port}",
  },
  {
    name: "astro-islands",
    dir: "packages/astro/e2e/islands",
    build: "npm run build",
    targets: { root: "dist" },
    port: 4305,
    serve: "npx astro preview --port {port}",
  },
  {
    name: "svelte-app",
    dir: "packages/svelte/e2e/app",
    build: "npm run build",
    targets: { root: "dist" },
    port: 4306,
    serve: "npx vite preview --port {port} --strictPort",
  },
  {
    name: "sveltekit-app",
    dir: "packages/sveltekit/e2e/app",
    build: "npm run build",
    targets: { root: "build" },
    port: 4307,
    serve: "node serve.mjs {port}",
  },
  {
    name: "vue-vite",
    dir: "packages/vue/e2e/vite",
    build: "npm run build",
    targets: { root: "dist" },
    port: 4308,
    serve: "npx vite preview --port {port} --strictPort",
  },
  {
    name: "nuxt-app",
    dir: "packages/nuxt/e2e/app",
    build: "npm run build",
    targets: { root: ".output/public/_nuxt" },
    port: 4309,
    serve: "node serve.mjs {port}",
  },
  {
    name: "angular-app",
    dir: "packages/angular/e2e/app",
    build: "npm run build",
    targets: { root: "dist/angular-fixture/browser" },
    port: 4310,
    serve: "node serve.mjs {port}",
  },
  {
    name: "parcel-app",
    dir: "packages/parcel/e2e/app",
    build: "rm -rf .parcel-cache dist && npm run build",
    env: { COLUMNS: "1000", LINES: "50" },
    targets: { root: "dist" },
    port: 4311,
    serve: "node serve.mjs {port}",
  },
  {
    name: "electron-app",
    dir: "packages/electron/e2e/app",
    build: "npm run build",
    targets: { main: "out/main", preload: "out/preload", renderer: "out/renderer" },
    port: 4312,
    serve: "node harness/serve-renderer.mjs out/renderer {port}",
  },
  {
    name: "cli-vanilla-esm",
    dir: "packages/cli/e2e/vanilla-esm",
    build: "npm run build",
    targets: { root: "dist" },
    port: 4313,
    serve: "node serve.mjs {port}",
  },
  {
    name: "cli-requirejs-amd",
    dir: "packages/cli/e2e/requirejs-amd",
    build: "npm run build",
    targets: { root: "dist/modules" },
    port: 4314,
    serve: "node serve.mjs {port}",
  },
  {
    name: "cli-single-file",
    dir: "packages/cli/e2e/single-file",
    build: "npm run build",
    targets: { root: "dist" },
  },
  {
    name: "next-app-turbopack",
    dir: "packages/next/e2e/app",
    build: "npm run build",
    env: { AFTERPACK_E2E_DIST_DIR: ".next" },
    targets: { client: ".next/static/chunks", server: ".next/server" },
    port: 4315,
    serve: "npx next start --port {port}",
  },
  {
    name: "next-app-webpack",
    dir: "packages/next/e2e/app",
    build: "npm run build:webpack",
    env: { AFTERPACK_E2E_DIST_DIR: ".next-webpack" },
    targets: { client: ".next-webpack/static/chunks", server: ".next-webpack/server" },
    port: 4316,
    serve: "npx next start --port {port}",
  },
  {
    name: "next-pages-turbopack",
    dir: "packages/next/e2e/pages",
    build: "npm run build",
    env: { AFTERPACK_E2E_DIST_DIR: ".next" },
    targets: { client: ".next/static/chunks", server: ".next/server" },
    port: 4317,
    serve: "npx next start --port {port}",
  },
  {
    name: "next-pages-webpack",
    dir: "packages/next/e2e/pages",
    build: "npm run build:webpack",
    env: { AFTERPACK_E2E_DIST_DIR: ".next-webpack" },
    targets: { client: ".next-webpack/static/chunks", server: ".next-webpack/server" },
    port: 4318,
    serve: "npx next start --port {port}",
  },
  {
    name: "next-static-export",
    dir: "packages/next/e2e/static-export",
    build: "npm run build",
    env: { AFTERPACK_E2E_DIST_DIR: ".next" },
    targets: { out: "out" },
    port: 4319,
    serve: "npx serve out -p {port} -L",
  },
];

function toFixture(spec: FixtureSpec): Fixture {
  const dir = join(REPO_ROOT, spec.dir);
  const port = spec.port ?? null;
  return {
    name: spec.name,
    relativeDir: spec.dir,
    dir,
    buildCommand: spec.build,
    env: spec.env ?? {},
    targets: Object.entries(spec.targets).map(([label, path]) => ({
      label,
      path: join(dir, path),
    })),
    port,
    serveCommand: spec.serve && port ? spec.serve.replaceAll("{port}", String(port)) : null,
    baseURL: port ? `http://localhost:${port}` : null,
    buildLog: join(dir, ".afterpack", `e2e-build-${spec.name}.log`),
  };
}

export const FIXTURES: Fixture[] = SPECS.map(toFixture);

export function fixture(name: string): Fixture {
  const found = FIXTURES.find((f) => f.name === name);
  if (!found) throw new Error(`no e2e fixture named "${name}"`);
  return found;
}

export function fixtureDirs(): string[] {
  return [...new Set(FIXTURES.map((f) => f.dir))].sort();
}

export function baseURLOf(target: Fixture): string {
  if (!target.baseURL) throw new Error(`e2e fixture "${target.name}" serves no browser surface`);
  return target.baseURL;
}
