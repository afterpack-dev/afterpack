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
pnpm test        # every package's unit tests
pnpm e2e         # Playwright, packages/*/e2e (pnpm e2e:quick for the PR subset; pnpm e2e:install first)
pnpm typecheck   # needs a build first: plugins typecheck against built declarations
pnpm lint:fix    # biome, autofixing — run it after any edit
pnpm hygiene     # the repo hygiene guardrail described below
pnpm check:comments   # no explanatory comments anywhere; CI enforces it
```

Run `pnpm build` before `pnpm typecheck`: the plugins resolve
`@afterpack/integration-utils` through its built `dist/index.d.ts`.

## How tests run

Every package's unit tests replace `@afterpack/core` with a test double, so the suite needs no
native binary and runs the same everywhere — against `@afterpack/core@latest` from npm, the engine a
user actually installs. `e2e` builds each `packages/*/e2e` fixture for real with its own
bundler, obfuscates it with the real plugin, and drives the result with Playwright — the class of
bug a correct-looking bundle can still fail at, which no unit test can catch.

## Release channels

- **`rc`** — every push to `main` publishes every package as `X.Y.Z-rc.<utc>` under the `rc`
  dist-tag, with provenance. Try it with `npx afterpack@rc`.
- **`latest`** — a maintainer promotes one RC by hand (the `Promote` workflow, with that RC's
  version). The same tree is republished as the clean `X.Y.Z` and tagged `vX.Y.Z`.

Every package in this repository carries **one version**. `pnpm version:set --version X.Y.Z` writes
it everywhere; never bump a single package on its own.

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
