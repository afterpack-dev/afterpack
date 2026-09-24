---
name: afterpack
description: Obfuscate a project's build output with the AfterPack CLI. When to run it, how to configure it, how to read its JSON output, and how to verify the result before deploying.
---

# Using the AfterPack CLI

AfterPack obfuscates JavaScript that a build has already emitted. Run it on build output, after
the bundler. Never run it on source.

## Pick the right tool first

If the project uses a framework or bundler with an AfterPack plugin, install the plugin instead of
adding a CLI step. The plugin obfuscates inside the build, so the readable bundle never reaches
disk:

| Project uses | Install |
| --- | --- |
| Vite | `@afterpack/vite` |
| Next.js 15.4+ | `@afterpack/next` |
| webpack 5 | `@afterpack/webpack` |
| Rollup | `@afterpack/rollup` |
| esbuild | `@afterpack/esbuild` |
| Parcel 2 | `@afterpack/parcel-optimizer` |
| Astro, Nuxt, SvelteKit, Svelte, Vue | `@afterpack/astro`, `nuxt`, `sveltekit`, `svelte`, `vue` |
| Angular 17+ | `@afterpack/angular`, or the CLI after `ng build` |
| Electron | `@afterpack/electron` |

Running `npx afterpack@latest` with no path in the project root prints the right package and exits
`1`. Use the CLI when no plugin fits, for a plain script, or when the build is not JavaScript
tooling. Setup guides: https://www.afterpack.dev/docs/frameworks

## Running it

```jsonc
// package.json
{
  "scripts": {
    "build": "vite build && afterpack dist"
  }
}
```

```bash
npx afterpack@latest dist                        # a directory, walked recursively
npx afterpack@latest dist/bundle.js              # or one .js, .mjs or .cjs file
npx afterpack@latest dist --preset=hard --seed=git
npx afterpack@latest dist --diagnostics.format=json
npx afterpack@latest verify .                    # check before deploying
npx afterpack@latest restore                     # undo the last run
npx afterpack@latest audit https://example.com   # scan a live site
npx afterpack@latest --help                      # common options
npx afterpack@latest --help --all                # every option, its type and default
```

Always write `afterpack@latest`. Bare `npx afterpack` can run a stale cached copy.

Rules:

- Point it at build output, never at `src/`.
- Run it once per build. Files are rewritten in place, and a second run over the same output is
  refused (exit `1`). Rebuild first.
- A path argument always obfuscates. With no path, the CLI checks the project for a framework
  first; if it finds none, it picks the newest of `dist/`, `build/`, `out/`, `.output/`, `.next/`.
  It never prompts.
- Nested `node_modules/` are skipped. `--paths.include='**/node_modules/**'` (quoted) adds them.

## What a run writes

- `.afterpack-protection.json` in the output directory: the receipt `afterpack verify` checks.
- `.afterpack/backup/`: the original files, on by default for the CLI, so `afterpack restore` can
  undo the run. `--build.backup=false` turns it off.
- `.afterpack/protectionMap.html`: the Protection Map report, when the build has source maps.
- `.map` files beside the output, when an input map exists and the run is not a production build.

The backup and the Protection Map contain the original source. AfterPack adds `.afterpack/` to the
nearest `.gitignore`. Never deploy, publish or commit them.

## Configuration

Every option has one dot-delimited camelCase name, used the same way in every place:

1. `/* @afterpack key=value */` in source, for region-scoped keys such as `preset` and `complexity`
2. `--key=value` on the command line
3. `AFTERPACK_<key with dots as underscores>` in the environment, for example
   `AFTERPACK_diagnostics_format=json`
4. `afterpack.json`, the nearest one at or above the working directory

Higher in the list wins. A boolean flag on its own means `true`; `=false` turns it off. There is
no `--no-` form and no space-separated value (`--seed git` is wrong, `--seed=git` is right). The
only short flags are `-h` and `-v`. An unknown, kebab-cased or malformed key fails the run with
exit `64` and names the right spelling.

| Key | Meaning | Default |
| --- | --- | --- |
| `preset` | `minify`, `light`, `medium`, `hard` or `extreme` | `light` |
| `complexity` | numeric protection level, overriding the preset's | the preset's value |
| `seed` | fix the seed; `git` uses the current commit | a new random seed per build |
| `paths.exclude` | globs to leave untouched | `[]` |
| `paths.include` | globs to add back to the walk | `[]` |
| `identifiers.reserved` | names never to rename | `[]` |
| `build.backup` | keep originals in `.afterpack/backup/` | `true` for the CLI, `false` in plugins |
| `sourceMap.enabled` | write `.map` files | on when an input map exists, off in production |
| `protectionMap.enabled` | write the Protection Map | on when an input map exists |
| `diagnostics.format` | `text` or `json` | `text` |
| `diagnostics.level` | `summary`, `all` or `none` (errors still print) | `summary` |
| `allowUnobfuscated` | ship a file that could not be processed, instead of failing (exit `2`) | `false` |
| `build.autorun` | `false` turns AfterPack off for the project, CLI and plugins alike | `true` |
| `telemetry.enabled` | anonymous diagnostics, sent only when a build is refused or partial | `true` |

`afterpack.json` is shared by the CLI and every plugin, and takes the whole schema, nested:

```json
{
  "preset": "hard",
  "seed": "git",
  "paths": { "exclude": ["**/*.min.js", "dist/vendor/**"] },
  "identifiers": { "reserved": ["Hls", { "glob": "src/legacy/**", "names": ["jQuery"] }] }
}
```

Full reference: https://www.afterpack.dev/docs/config

## Machine-readable output

Read `--diagnostics.format=json` output instead of parsing text. Stdout carries exactly one JSON
document, with no colour or progress; everything else goes to stderr. `verify` and `audit` support
it too. Add `--diagnostics.level=none` for a run that prints nothing else.

```json
{
  "afterpack": "0.1.0",
  "command": "obfuscate",
  "exitCode": 0,
  "ok": true,
  "files": [
    { "path": "dist/app.js", "status": "obfuscated", "bytesIn": 4211, "bytesOut": 15980, "diagnostics": [] }
  ],
  "diagnostics": [{ "code": "DIAG_TARGET_REACHED", "level": "info", "message": "…", "file": "dist/app.js" }],
  "summary": { "files": 1, "transformed": 1, "seed": 4242, "engine": "local", "diagnostics": { "total": 1 } },
  "artifacts": { "protectionMap": ".afterpack/protectionMap.html" }
}
```

`status` is `obfuscated`, `unchanged`, `unobfuscated` or `failed`. A failure is a document too,
with the same exit code and a `fix` field to act on:

```json
{
  "afterpack": "0.1.0",
  "command": "obfuscate",
  "exitCode": 3,
  "ok": false,
  "error": { "code": "DIAG_SIZE_CAP_REACHED", "message": "…", "fix": "Raise --inflation.max, or lower --complexity, …" }
}
```

Lists are sorted and there are no timestamps, so two runs of one build give identical documents.

## The Pro key

Without a key, builds run locally with basic protection. With a Pro key, the same command sends the
build to AfterPack's cloud, which applies much stronger protection.

- Set it as `AFTERPACK_KEY` in the environment (a CI secret), or `key` in an uncommitted
  `afterpack.json`.
- Never put it in a plugin's options object. Plugins reject it there, because a bundler config is
  committed source.
- Never commit it.
- If the cloud cannot be reached, the run fails with exit `1`. It never falls back to weaker output.

Details: https://www.afterpack.dev/docs/pro

## `afterpack verify [dir]`

Add this to the deploy step. It re-hashes every file the protection receipt names.

```bash
npx afterpack@latest verify .        # looks in ./ and ./.next/
npx afterpack@latest verify dist
```

It exits `1` when the receipt is missing, belongs to a different build, or a file changed after it
was obfuscated. A missing receipt is a failure. `verify` reads no configuration and takes only
`--diagnostics.format` and `--diagnostics.level`.

## `afterpack restore [dir]`

Puts the originals from `.afterpack/backup/` back. It checks each file still matches what the run
wrote and skips (and names) any that changed since, exiting `1` if any were skipped. With no backup
there is nothing to restore, and it exits `1`.

```bash
npx afterpack@latest restore         # the project root holding .afterpack/backup/
npx afterpack@latest restore dist
```

## `afterpack audit <url>`

Scans a deployed site for leaked secrets, exposed source maps and unprotected JavaScript, streams
findings as they arrive, and prints a link to the full report. A bare host gets `https://`. It sends
only the URL and writes nothing. A finished scan exits `0` however much it found; a failed scan
exits `1`. Anonymous use is rate-limited per 24 hours. Docs: https://www.afterpack.dev/docs/audit

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success. Also `--help` and `--version`. |
| `1` | Failure: bad path, no JavaScript found, an engine error, an already-obfuscated tree, a failed `verify`, `restore` or scan, or an unreachable cloud on a Pro build. |
| `2` | Partial: some files shipped unobfuscated. Only with `allowUnobfuscated`. |
| `3` | Size cap: `inflation.max` stopped the run before it reached the protection level. |
| `6` | Update required. Run the install command it prints, for example `npm install afterpack@latest @afterpack/core@<version>`. Nothing was written. |
| `64` | Misuse: unknown flag or command, malformed value, or two path arguments. |

Every non-zero exit prints one line that says how to fix it. A failed run leaves the build output
exactly as the bundler wrote it.
