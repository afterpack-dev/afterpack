# Contributing to AfterPack

Issues and pull requests are welcome on the CLI, the framework integrations and the shared helpers
— everything in this repository. The obfuscation engine itself is `@afterpack/core`, a proprietary
package this repository consumes from npm; its source is not in this repository.

## Setup

Node 18 or newer, and pnpm — the version is pinned by `packageManager` in the root `package.json`,
so `corepack enable` is enough to get the right one.

```bash
pnpm install
pnpm build       # every package, in dependency order
pnpm test        # every package's unit tests, then the release scripts' (scripts/test)
pnpm e2e         # Playwright, packages/*/e2e (pnpm e2e:quick for the PR subset; pnpm e2e:install first)
pnpm typecheck   # needs a build first: plugins typecheck against built declarations
pnpm lint:fix    # biome, autofixing — run it after any edit
pnpm hygiene     # the repo hygiene guardrail described below
pnpm check:comments   # no explanatory comments anywhere; CI enforces it
```

Run `pnpm build` before `pnpm typecheck`: the plugins resolve
`@afterpack/integration-utils` through its built `dist/index.d.ts`.

## How tests run

Every package's unit tests replace `@afterpack/core` with `test/core-fake.ts`, a shared test double
aliased in by every `vitest.config.ts`, so the suite needs no native binary and runs the same
everywhere. `pnpm test` is the contribution path that works without the engine.

`pnpm e2e` builds each `packages/*/e2e` fixture for real with its own bundler, obfuscates it with the
real plugin against the published `@afterpack/core`, and drives the result with Playwright — the
class of bug a correct-looking bundle can still fail at, which no unit test can catch. It needs
`@afterpack/core` to resolve from the npm registry, and fails until it does. `e2e/README.md` covers
the lanes, the environment variables that pick fixtures, shards and browsers, and how to write a
scenario.

## Reproduce a bug as a failing e2e test

A coding agent is the fastest way through the steps below: point it at this repository, ask it to reduce your project to the smallest app that still shows the bug, and then to write the spec. `AGENTS.md` and `packages/cli/SKILL.md` give it the layout, the commands and the CLI's behaviour.

1. Create `packages/<fw>/e2e/<fixture>/`: a minimal app for the framework, with its own
   `package.json` and a committed `package-lock.json`.
2. Register it in `e2e/helpers/registry.ts`'s `SPECS` array: a name, its directory, the build
   command, the build's output targets, and — if it serves a browser surface — a port and a serve
   command. `playwright.config.ts` turns every entry into a Playwright project automatically.
3. Add `packages/<fw>/e2e/<fixture>/expectations.json` describing what the build must produce.
4. Add `<fixture>.spec.ts` beside the fixture, using the helpers in `e2e/helpers/`:
   `expectObfuscationPass` asserts the pass actually ran, `expectObfuscationSignatures` that the
   shipped files are obfuscated rather than merely minified, and `runSmoke` drives the built app with
   Playwright. A bug that shows only after a click or a navigation is best written as a `scenario`,
   which runs the same steps against an unprotected build and requires both to behave alike.
5. Run just that fixture: `AFTERPACK_E2E_FIXTURES=<name> pnpm e2e`.

Tag the fastest, most representative test `@quick` — that tag is the PR lane (`pnpm e2e:quick`); the
full suite, in Chromium, Firefox and WebKit, runs on push to `main`.

## Releases

One lane publishes to `latest`; there is no release-candidate channel for the CLI and plugins.

- **`Release`** decides the version, runs the checks, the full e2e suite and the Pro path on one
  commit, publishes every package with provenance, then installs the published CLI from npm on
  Ubuntu, macOS and Windows and runs it on `scripts/smoke-fixtures`. A manual run releases the
  commit it runs on with the `bump` it names. It releases nothing when no package ships a change
  against its npm `latest`: it packs each package and compares the tarball with the one npm
  serves, so tests, fixtures, CI and the root readme never cause a release.
- **engine** — `@afterpack/core`, its platform packages and `@afterpack/wasm` are built outside
  this repository and published to npm by `Publish engine`, without provenance, because their
  source is not here. Once npmjs serves a `latest` engine it sends `core-published`, and
  `Release` repins `@afterpack/core` in every package, waits for npmjs, rewrites the lockfile,
  runs the gates, pushes the bump to `main` and releases it. A new release line (a minor under
  major 0) also moves every package version and `MIN_CORE_VERSION` to that line:
  `node scripts/bump-engine.mjs <version>` makes the same change locally.
- **`RC smoke`** installs an engine build on every OS it ships a native binding for, and fails
  unless each binding loads natively, reports its version, and produces protected output that
  still runs and matches Linux byte for byte.
- **`Approve`** is the single human approval for a production ship; the release tooling
  dispatches it and waits. Dispatching `Release` or `Publish engine` directly publishes with no
  further approval.

Both publishing workflows are safe to re-run: every step checks npmjs first, skips a version it
already serves with the same files, treats "cannot publish over" (E403/E409) as published, and
waits up to 45 minutes for npmjs to serve each tarball before anything depends on it. A package
npmjs already holds at that version with different files fails the publish before anything is
published. Their file names and the `npm` environment are what the npm trusted publishers are
bound to; never rename them.

Resume a failed `Release` with **Re-run failed jobs** on that run, never a fresh run. A fresh run
that finds every package already published releases nothing, so `vX.Y.Z` is never tagged and no
GitHub Release is created; one whose packages differ from the half-published ones fails before it
publishes any. To abandon a half-published version, raise the root `package.json` version past it.

Every package in this repository carries **one version**, stamped at publish time and never
committed: the root `package.json` version is a floor, and the next version is one bump above the
last `vX.Y.Z` tag or the npm `latest`, whichever is higher. `node scripts/release-plan.mjs changed`
shows what a release would ship; never bump a single package on its own.

## Pull requests

CI (`ci.yml`) runs on GitHub-hosted runners with no secrets, so a fork PR runs it in full: keep PRs
green. Conventional Commits — `<type>(<scope>): <description>`, types `feat` `fix` `docs` `chore`
`refactor` `test` `ci`.

## The hygiene rule

This repository must stay self-contained. `pnpm hygiene` runs in CI and fails on:

- a tracked `.npmrc`, or a registry/auth-token line with a literal value;
- a `postinstall`, `preinstall`, `prepare` or `install` script in any package;
- an absolute path into a particular machine's filesystem;
- a `file:` reference that resolves outside this repository, or points at a packed tarball;
- any other relative path that escapes this repository's root.

The patterns in `check-hygiene.mjs` are split with `(?:)` so the script does not match itself; keep
that when editing them.

## Conventions

**No lifecycle scripts.** No AfterPack package runs anything on install. Framework wiring is an
explicit command, never something that happens to you.

**TypeScript, ESM.** Relative imports carry a `.js` extension. Tests live beside their source as
`*.test.ts`, or under the package's `test/` directory.

**No explanatory comments.** Code says what it does; tests say what it must do. The only comments
are tool directives such as `biome-ignore`.

**Configuration naming.** One registry (`packages/integration-utils/src/registry.ts`) defines every
user-facing key, and everything else is derived from it: the TypeScript options type, the runtime
validator, the CLI help, and the subset forwarded to the engine. Keys are dot-delimited camelCase
and are spelled **identically** on all four surfaces:

| Surface | Form |
| --- | --- |
| `afterpack.json` | nested: `{ "protectionMap": { "enabled": false } }` |
| command line | `--protectionMap.enabled=false` |
| environment | `AFTERPACK_protectionMap_enabled=false` |
| plugin options | `{ protectionMap: { enabled: false } }` |

There are no short flags, no `--no-` forms and no space-separated values. A boolean key written
alone means `true`. An unknown key, a kebab-cased key or a malformed value **fails** the run naming
the canonical spelling — it is never silently ignored. Adding a key means adding it to the registry;
every surface then accepts it without further work.
