# AfterPack

AfterPack obfuscates the JavaScript a build already emitted. This repository holds the `afterpack`
CLI, 13 framework integrations, and the two shared packages they build on, all Apache-2.0.

The obfuscation engine is `@afterpack/core`, an npm dependency; its source is not in this repository.

## Layout

```
packages/
  cli/                 afterpack — the bin; `<path>` and `verify`
  integration-utils/   @afterpack/integration-utils — config registry, source maps,
                       directives, the obfuscation pass, artifact writing
  protection-map/      @afterpack/protection-map — the self-contained HTML report viewer
  angular/             @afterpack/angular — Angular 17+, an ng build postbuild step
  astro/               @afterpack/astro — Astro integration
  electron/            @afterpack/electron — main, preload and renderer, one seed
  esbuild/             @afterpack/esbuild — esbuild plugin
  next/                @afterpack/next — Next.js integration
  nuxt/                @afterpack/nuxt — Nuxt 3 (Vite) module
  parcel/              @afterpack/parcel-optimizer — Parcel 2 optimizer
  rollup/              @afterpack/rollup — Rollup plugin
  svelte/              @afterpack/svelte — Svelte on Vite
  sveltekit/           @afterpack/sveltekit — SvelteKit on Vite
  vite/                @afterpack/vite — Vite plugin
  vue/                 @afterpack/vue — Vue 3 (Vite) integration
  webpack/             @afterpack/webpack — webpack plugin
  */e2e/               Playwright fixtures, one per package, driven by playwright.config.ts
test/core-fake.ts       the shared `@afterpack/core` test double, aliased in by every vitest.config.ts
scripts/                set-version.ts, check-hygiene.mjs, check-comments.mjs
.github/workflows/      ci (contributor), rc (publish on push to main), promote
.github/ISSUE_TEMPLATE/ bug report form, issue config
.github/PULL_REQUEST_TEMPLATE.md   the PR gate checklist
playwright.config.ts    root Playwright config for every packages/*/e2e fixture
SECURITY.md             where to report a vulnerability
CODE_OF_CONDUCT.md      Contributor Covenant 2.1 by reference
```

## Commands

```bash
pnpm install
pnpm build       # every package, in dependency order
pnpm test        # unit tests
pnpm e2e         # Playwright, packages/*/e2e (pnpm e2e:quick for the PR subset; pnpm e2e:install first)
pnpm lint:fix    # biome, autofixing — run after any file change
pnpm typecheck   # after a build: plugins typecheck against built declarations
pnpm hygiene     # repo hygiene guardrail; CI fails on it
pnpm check:comments   # no explanatory comments anywhere; CI enforces it
```

## Conventions

TypeScript, ESM, relative imports with a `.js` extension. Conventional Commits. No lifecycle
scripts (`postinstall`, `preinstall`, `prepare`) in any package, ever.

**Module formats.** `integration-utils` and every plugin a config file imports ship ESM and
CommonJS (`tsdown --format esm --format cjs --shims`, `import` and `require` conditions), so a
CommonJS config can `require` them on Node without `require(esm)`. The CJS build of
`integration-utils` bundles `@afterpack/protection-map`. The CLI, `parcel` and `protection-map`
stay ESM. State that must be one per
process (seed sessions, Electron notices) lives on `globalThis` under a `Symbol.for` key, so the
two copies share it.

**Configuration naming.** One dot-delimited camelCase name per option. Every option is spelled
identically as an `afterpack.json` field, a `--flag`, an `AFTERPACK_env` variable, and a plugin
option. An unknown key fails the run naming the canonical spelling — it is never silently ignored.

**No explanatory comments.** Code says what it does; tests say what it must do. The only comments
are tool directives such as `biome-ignore`.

## Using the CLI

Read `packages/cli/SKILL.md` for how to run AfterPack against a real project.
