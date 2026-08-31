# AfterPack CLI

> `npx afterpack` — the PUBLIC, thin TypeScript wrapper around `@afterpack/core`.

This repo is public and accepts community issues/PRs. It contains CLI UX only — no engine source.
The Rust engine lives in the private `platform` repo and reaches users as the `@afterpack/core`
npm dependency (native binary via napi-rs).

## Layout

```
src/
  cli.ts               # entry point; arg parse + switch on the subcommand
  cli.test.ts          # colocated E2E tests (vitest)
  commands/
    audit.ts           # `audit <url>`     — SSE scan against the AfterPack API
    obfuscate.ts       # `obfuscate <file.js>` — calls @afterpack/core process()
  utils/
    format.ts          # ANSI colour + header-box helpers
    sse.ts             # generic async-iterable SSE-over-fetch reader
scripts/
  prepack.ts           # strips internal dev scripts from package.json before publish
  postpack.ts          # restores it from package.json.backup
.github/workflows/
  ci.yml               # push/PR → build + test, ONE leg (Node 22 / ubuntu)
  publish.yml          # tag push + repository_dispatch → npm publish
```

`@afterpack/core` is loaded **lazily at runtime** and imported `import type` at the top level, so
the native addon never lands in the bundle. Keep it that way.

## Commands

```bash
pnpm install
pnpm build       # tsdown → dist/cli.js (ESM + .d.ts)
pnpm dev         # tsdown --watch
pnpm test        # vitest run
pnpm lint:fix    # biome check --write .   ← run after any file change
```

## Publishing

`ci.yml` only builds and tests. **`publish.yml` is what publishes**, on two triggers:

- **tag push `v*`** — publishes to npm with `--provenance`. A `v*-rc.*` tag goes to dist-tag `rc`,
  anything else to `latest`.
- **`repository_dispatch` type `core-published`** — fired by the platform repo on a STABLE promote
  only (never an RC): bumps the `@afterpack/core` dependency, tests, `npm version patch`, then
  commits + tags, and that tag re-enters via the trigger above. It **fails deliberately** on a major
  version change rather than auto-updating.

This CLI versions **independently** of the lockstep `@afterpack/*` train.

## Conventions

- TypeScript only, ESM only. Relative imports carry a `.js` extension.
- Tests colocated as `*.test.ts`.
- [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/): `<type>(<scope>): <desc>`,
  types `feat` `fix` `docs` `chore` `refactor` `test` `ci`.

## Local development against an unpublished engine

```bash
cd ../platform/packages/core && pnpm build && pnpm pack
cd -                          && pnpm add ./../platform/packages/core/afterpack-core-*.tgz && pnpm build
```

Maintainers with access to the private RC registry can instead install the `rc` dist-tag; see the
platform repo for the registry URL and read-only token.
