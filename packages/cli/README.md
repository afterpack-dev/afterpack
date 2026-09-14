# afterpack

The `afterpack` CLI obfuscates the JavaScript a build already emitted. Run it after your bundler,
over the build output — vanilla ESM, `require`/AMD, a lone script, or a CI step.

```sh
npx afterpack@latest                       # detects the build output
npx afterpack@latest dist                  # or name the directory
npx afterpack@latest dist/bundle.js        # or one .js / .mjs / .cjs file
npx afterpack@latest dist --preset=hard --seed=git
npx afterpack@latest verify .              # the deploy gate
npx afterpack@latest audit https://example.com
```

If your `package.json` names a bundler with a plugin (`@afterpack/vite`, `@afterpack/webpack`,
`@afterpack/rollup`, `@afterpack/esbuild`, `@afterpack/next`, `@afterpack/nuxt`), the CLI says so at
the end of a run: a plugin hooks the build itself, so the cleartext bundle is never written to disk.

## `afterpack [path]`

A directory is walked recursively for every `.js`, `.mjs` and `.cjs`; a single file is obfuscated on
its own. AfterPack's own `.backup.<hash>` copies are never re-obfuscated, and nested `node_modules/`
are skipped — pass `--paths.include='**/node_modules/**'` to walk them too (quote it, or the shell
expands the glob first).

**Omit the path** and `afterpack` picks the build output itself: the directory your detected bundler
writes (Next → `.next/`, Nuxt → `.output/`, everything else → `dist/`), else the newest of `dist/`,
`build/`, `out/`, `.output/`, `.next/`. It prints what it found and what it will do, then runs. It
never prompts, in a terminal or in CI. When it finds nothing it prints the quickstart and exits `1`.

### Output is written in place

The files under `[path]` are **replaced** with their obfuscated form, and no copy is kept to
re-obfuscate from. **Build, then run it once.** A second run over the same, unrebuilt tree is
**refused** (`DIAG_ALREADY_OBFUSCATED`): the run records a sha256 per shipped file in the protection
receipt below, so AfterPack recognises its own output rather than obfuscating it twice.

Every run writes `.afterpack-protection.json` — the protection receipt `afterpack verify` reads back
— into the directory it walked. Alongside the output AfterPack may also write:

- `foo.js.map` — the composed source map, when an upstream map was found (off in a detected
  production build).
- `foo.backup.<hash>.js` — the original file, only with `--build.backup`.
- `.afterpack/protectionMap.html` — one combined, self-contained Protection Map for the whole run,
  in a gitignored directory rather than in your output.

Every one of those contains your original source. Never serve, publish or commit them:

```gitignore
.afterpack/
*.protectionMap.html
*.backup.*.js
```

The CLI adds any of these globs that are missing to the nearest `.gitignore` above the build output, when one exists, and
warns once if an artifact lands under a served path segment.

## `afterpack verify [dir]`

The deploy gate. Every AfterPack run that writes to disk leaves a **protection receipt** in the tree
it wrote — `afterpack <dir>` does, and so does `@afterpack/next` from inside `next build` — listing
the tool, the engine version, the seed, the bundler, the build id and a sha256 per obfuscated file.
`verify` reads that receipt back and re-hashes everything it names.

```sh
npx afterpack@latest verify .        # a project root: looks in ./ then ./.next/
npx afterpack@latest verify .next    # or the build output directory itself
```

It exits non-zero when the receipt is **missing** (nothing protected this tree), when it is from a
**different build** (rebuilt without the wrapper), or when any recorded file **no longer hashes** to
what it was obfuscated to (replaced after the build). A missing receipt is a failure, never a quiet
pass. It reads no configuration; it takes only `--diagnostics.format` and `--diagnostics.level`.

## `afterpack audit <url>`

Scans a **deployed** site for leaked secrets, exposed source and unprotected JavaScript, streaming
the findings as they land.

```sh
npx afterpack@latest audit example.com
npx afterpack@latest audit https://example.com --diagnostics.format=json
```

A bare host is normalised to `https://`. It reads no configuration and writes no file; it sends
nothing but the URL. `AFTERPACK_API_URL` overrides the endpoint. Findings are a **result**, not a
failure: a completed scan exits `0` however much it found, and the report link is printed at the end.
Unregistered use is rate-limited per 24h, and the limit is reported as such rather than as an HTTP
error.

## Configuration

Every option is written the same way in all four places, derived from the key rather than from a
per-flag table: `--key=value` here, `AFTERPACK_<key with dots replaced by underscores>` in the
environment, nested in `afterpack.json` (the nearest one at or above the working directory), and —
for the region-scoped keys — in an `/* @afterpack key=value */` source directive.

Most specific wins:

1. an `/* @afterpack key=value */` source directive (region-scoped keys only)
2. a `--key=value` flag
3. `AFTERPACK_<key_with_underscores>` in the environment
4. `afterpack.json`

Keys are dot-delimited camelCase and identical on every surface. A boolean key written alone means
`true`; `=false` switches it off. The only short flags are `-h` and `-v`; there is no `--no-` form
and no space-separated value. An unknown key, a kebab-cased key or a malformed value **fails the
run** naming the canonical spelling — it is never silently ignored. `afterpack --help` lists every
key with its type and default.

| Flag | Description | Default |
| --- | --- | --- |
| `--preset=<name>` | `minify` \| `light` \| `medium` \| `hard` \| `extreme` — a bundle of complexity target, output-size multiplier and inflation budget | `light` |
| `--complexity=<n>` | raw numeric complexity target, overriding just the preset's target | the preset's target |
| `--seed=<n\|string>` | pin the build seed (`git` derives it from the current commit) | fresh random per build |
| `--diagnostics.format=<text\|json>` | `json` prints ONE JSON document on stdout and moves every human line to stderr | `text` |
| `--diagnostics.level=<summary\|all\|none>` | rolled up, every engine diagnostic, or silent (errors still print) | `summary` |
| `--protectionMap.enabled=false` | skip writing the Protection Map | on when an upstream map is found |
| `--build.backup` / `--build.backup=false` | keep / skip a `.backup.<hash>.js` copy of each original | off |
| `--sourceMap.enabled=false` | skip writing `.map` siblings | auto (on iff an upstream map exists) |
| `--paths.include=<glob[,glob]>` | re-admit what the walk skips; `**/node_modules/**` walks nested `node_modules/` | `[]` |
| `--paths.exclude=<glob[,glob]>` | leave matching files untouched | `[]` |
| `--identifiers.reserved=<name[,name]>` | identifier names never renamed | `[]` |
| `--allowUnobfuscated` | ship a file the engine could not obfuscate, as cleartext, instead of failing | `false` |
| `--build.autorun=false` | skip obfuscation entirely — the project-wide "AfterPack is off" switch, honoured here exactly as a bundler plugin honours it, so one setting cannot mean two things | `true` |
| `--help` / `-h`, `--version` / `-v` | print usage / the installed version | |

`--telemetry.enabled=false` (or `AFTERPACK_telemetry_enabled=false`) turns off anonymous build
diagnostics; they are on by default and report only when a build fails.

### `afterpack.json`

The one config file, for the CLI and every plugin. `@afterpack/vite`, `rollup`, `webpack`, `esbuild`,
`astro`, `nuxt`, `svelte`, `sveltekit`, `vue`, `angular`, `electron`, `next` and `parcel-optimizer`
all read the same file, validated against the same schema, with their own options object outranking
it. It accepts the whole schema, nested, and an unknown key fails the build:

```json
{
  "preset": "hard",
  "seed": "git",
  "paths": { "exclude": ["**/*.min.js", "dist/vendor/**"] },
  "identifiers": { "reserved": ["Hls", { "glob": "src/legacy/**", "names": ["jQuery"] }] }
}
```

## Machine-readable output

`--diagnostics.format=json` (or `AFTERPACK_diagnostics_format=json`, or `diagnostics.format` in
`afterpack.json`) makes stdout carry **exactly one** JSON document and nothing else — no ANSI, no
progress. Every human line goes to stderr. Both `verify` and `audit` honour it too.

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

A failure is a document too, with the same exit code:

```json
{
  "afterpack": "0.1.0",
  "command": "obfuscate",
  "exitCode": 3,
  "ok": false,
  "error": { "code": "DIAG_SIZE_CAP_REACHED", "message": "…", "fix": "Raise --inflation.max, or lower --complexity, …" }
}
```

Lists are sorted and no field carries a timestamp, so two runs of one build produce byte-identical
documents.

## The Pro key

Set it as `AFTERPACK_KEY` in the environment, or as `key` in `afterpack.json`. Those are the only two
places the engine reads.

**Never put it in a plugin's options object** — no plugin forwards it, so a key set there validates,
builds green and silently runs the **free** engine. **Never commit it**: a bundler config is source
code. Without a key, builds run locally on the free engine, which is fully functional. A Pro build
that cannot reach the cloud **fails closed** at exit `1`; it never falls back to free-tier output.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success. Every collected file was obfuscated and written. Also `--help` and `--version`. |
| `1` | Total failure. Nothing usable was produced: a path that does not exist, no JavaScript found under it, any engine error, a failed `verify`, or a Pro build whose cloud call failed. |
| `2` | Partial. Some files shipped unobfuscated — only reachable with `allowUnobfuscated`. |
| `3` | Size cap. `inflation.max` could not reach the complexity target (`DIAG_SIZE_CAP_REACHED`). |
| `4` | **Reserved** — a Pro feature without a key, or a lapsed entitlement. Documented, never emitted. |
| `5` | **Reserved** — runtime reflection detected without `reflection.allow`. Documented, never emitted. |
| `64` | Misuse. An unknown flag or command, a malformed value, or a doubled path argument. |

Every non-zero exit prints one actionable line naming the fix. Fail-closed: nothing ships partially
obfuscated, and a failed run leaves your build output exactly as your bundler wrote it.

## Feedback

Questions and proposals: https://github.com/afterpack-dev/afterpack/discussions · Bugs: https://github.com/afterpack-dev/afterpack/issues
