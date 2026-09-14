---
name: afterpack
description: Obfuscate a project's build output with the AfterPack CLI — when to run it, how to configure it, how to read its JSON output, and how to verify the result at deploy time.
---

# Using the AfterPack CLI

AfterPack obfuscates JavaScript that a build **has already emitted**. It is a post-build step, not a
compiler, not a bundler plugin, and not something you run on source.

## When to run it

Run it **after** the bundler, over the build output:

```jsonc
// package.json
{
  "scripts": {
    "build": "vite build && afterpack dist"
  }
}
```

- **Point it at build output**, never at `src/`. Obfuscating source breaks the build that follows.
- **Run it once** per build. Output is written **in place** and no copy is kept, so a second run
  re-obfuscates already-obfuscated code: slower, larger, and worth nothing.
- **A bundler plugin is better where one exists.** `@afterpack/vite`, `@afterpack/next`,
  `@afterpack/webpack`, `@afterpack/rollup`, `@afterpack/esbuild`, `@afterpack/parcel-optimizer` and
  the framework wrappers hook the build itself, so the cleartext bundle is never written to disk.
  Reach for the CLI when no plugin fits, or when the build system is not JavaScript.

## Invocations

```bash
npx afterpack@latest                             # detects the build output, then runs
npx afterpack@latest dist                        # a directory, walked recursively
npx afterpack@latest dist/bundle.js              # or one .js / .mjs / .cjs file
npx afterpack@latest dist --preset=hard --seed=git
npx afterpack@latest dist --diagnostics.format=json
npx afterpack@latest verify .                    # the deploy gate
npx afterpack@latest audit https://example.com   # scan a DEPLOYED site
npx afterpack@latest --help                      # every key, its type and its default
npx afterpack@latest verify --help
npx afterpack@latest audit --help
npx afterpack@latest --version
```

Always pin `afterpack@latest` rather than bare `npx afterpack`, which can resolve to a stale cached
copy.

`[path]` is optional. **With no path**, AfterPack picks the build output itself: the directory the
bundler in your `package.json` writes (Next → `.next/`, Nuxt → `.output/`, everything else →
`dist/`), else the newest of `dist/`, `build/`, `out/`, `.output/`, `.next/`. It prints what it found
and what it will do, then runs — it never prompts, in a terminal or in CI, and it exits `1` with the
quickstart when it finds nothing.

Nested `node_modules/` are skipped; pass `--paths.include='**/node_modules/**'` (quoted — an
unquoted glob is expanded by the shell first) to walk them too. AfterPack's own `.backup.<hash>`
copies are never re-obfuscated.

## Output is written in place

The files under `[path]` are **replaced** with their obfuscated form. **Build, then run it once**: a
second run over the same, unrebuilt tree is **refused** (`DIAG_ALREADY_OBFUSCATED`), because the run
recorded a sha256 per shipped file in the protection receipt it left there. Every run writes that
`.afterpack-protection.json` into the directory it walked. Alongside them AfterPack may also write:

- `foo.js.map` — the composed source map, when an upstream map was found (off in a detected
  production build).
- `foo.backup.<hash>.js` — the original, only with `--build.backup`.
- `.afterpack/protectionMap.html` — one combined, self-contained report for the whole run, in a
  gitignored directory rather than in your output.

Add these to `.gitignore` (AfterPack adds any that are missing to the nearest `.gitignore` above the build output, when one exists):

```gitignore
.afterpack/
*.protectionMap.html
*.backup.*.js
```

Each of those contains your **original source**. They are local development artifacts: never serve
them, never publish them, never commit them.

## Configuration

Every option is written the same way in four places. Most specific wins:

1. an `/* @afterpack key=value */` source directive (region-scoped keys only)
2. a `--key=value` flag
3. `AFTERPACK_<key with dots replaced by underscores>` in the environment
4. `afterpack.json` — the nearest one at or above the working directory

Keys are dot-delimited camelCase and identical on every surface. The only short flags are `-h` and
`-v`; there is no `--no-` form and no space-separated value. A boolean key written alone means
`true`, and `=false` switches it off. An unknown key, a kebab-cased key or a malformed value **fails
the run** (exit `64`) naming the canonical spelling — nothing is silently ignored.

The options worth knowing (`--help` lists them all):

| Key | Meaning | Default |
| --- | --- | --- |
| `preset` | `minify` \| `light` \| `medium` \| `hard` \| `extreme` | `light` |
| `complexity` | raw numeric target, overriding the preset's | the preset's |
| `seed` | pin the build seed; `git` derives it from the current commit | fresh random per build |
| `paths.exclude` | globs to leave untouched | `[]` |
| `paths.include` | re-admit what the disk walk skips | `[]` |
| `identifiers.reserved` | identifier names never renamed | `[]` |
| `diagnostics.format` | `text` or `json` — see below | `text` |
| `diagnostics.level` | `summary`, `all`, or `none` (silent; errors still print) | `summary` |
| `allowUnobfuscated` | ship a file the engine could not obfuscate as cleartext (exit `2`) | `false` |
| `build.backup` | keep a `.backup.<hash>.js` copy of each original | `false` |
| `sourceMap.enabled` | write `.map` siblings | on iff an upstream map exists |
| `protectionMap.enabled` | write the local HTML report | on when an upstream map is found |
| `build.autorun` | `false` turns AfterPack off project-wide | `true` |
| `telemetry.enabled` | anonymous diagnostics, reported **only when a build fails** | `true` |

`afterpack.json` is the one config file, shared by the CLI and every plugin. It accepts the whole
schema, nested, and an unknown key fails the build:

```json
{
  "preset": "hard",
  "seed": "git",
  "paths": { "exclude": ["**/*.min.js", "dist/vendor/**"] },
  "identifiers": { "reserved": ["Hls", { "glob": "src/legacy/**", "names": ["jQuery"] }] }
}
```

## Machine-readable output

`--diagnostics.format=json` makes stdout carry **exactly one** JSON document and nothing else — no
ANSI, no progress. Every human line goes to stderr. It works from the flag,
`AFTERPACK_diagnostics_format=json`, or `diagnostics.format` in `afterpack.json`, and `verify` and
`audit` honour it too. Read it instead of parsing the text output.

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

`status` is `obfuscated`, `unchanged`, `unobfuscated` or `failed`. A failure is a document too, with
the same exit code and a `fix` field:

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
documents. Pair it with `--diagnostics.level=none` for a run that prints nothing but the document.

## The Pro key

Set it as `AFTERPACK_KEY` in the environment, or as `key` in `afterpack.json`. Those are the only two
places the engine reads.

**Never put it in a plugin's options object** — no plugin forwards it, so a key set there validates,
builds green and silently runs the **free** engine. **Never commit it**: a bundler config is source
code. Without a key, builds run locally on the free engine, which is fully functional. A Pro build
that cannot reach the cloud **fails closed** at exit `1`; it never falls back to free-tier output.

## `afterpack verify [dir]`

The deploy gate. Every AfterPack run that writes to disk leaves a **protection receipt** in the tree
it wrote — `afterpack <dir>` does, and so does `@afterpack/next` from inside `next build` — naming
the tool, the engine version, the seed, the bundler, the build id, and a sha256 per obfuscated file.
`verify` re-hashes everything the receipt names.

```bash
npx afterpack@latest verify .        # a project root: looks in ./ then ./.next/
npx afterpack@latest verify .next    # or the build output directory itself
```

It exits non-zero when the receipt is **missing** (nothing protected this tree), when it is from a
**different build** (rebuilt without the wrapper), or when a recorded file **no longer hashes** to
what it was obfuscated to (replaced after the build). A missing receipt is a failure, never a quiet
pass. `verify` reads no configuration; it takes only `--diagnostics.format` and
`--diagnostics.level`. Run it in the deploy step.

## `afterpack audit <url>`

Scans a **deployed** site for leaked secrets, exposed source and unprotected JavaScript, streaming
the findings as they land. A bare host is normalised to `https://`. It reads no configuration and
writes no file; it sends nothing but the URL. `AFTERPACK_API_URL` overrides the endpoint.

```bash
npx afterpack@latest audit example.com
npx afterpack@latest audit https://example.com --diagnostics.format=json
```

Findings are a **result**, not a failure: a completed scan exits `0` however much it found, and
prints the full report link. Unregistered use is rate-limited per 24h, reported as such rather than
as an HTTP error. A scan that failed or a stream that ended early exits `1`.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success. Every collected file was obfuscated and written. Also `--help` and `--version`. |
| `1` | Total failure. Nothing usable was produced: a path that does not exist, no JavaScript found under it, any engine error, a failed `verify`, a failed scan, or a Pro build whose cloud call failed. |
| `2` | Partial. Some files shipped unobfuscated — only reachable with `allowUnobfuscated`. |
| `3` | Size cap. `inflation.max` could not reach the complexity target (`DIAG_SIZE_CAP_REACHED`). |
| `4` | **Reserved** — a Pro feature without a key, or a lapsed entitlement. Documented, never emitted. |
| `5` | **Reserved** — runtime reflection detected without `reflection.allow`. Documented, never emitted. |
| `64` | Misuse. An unknown flag or command, a malformed value, or a doubled path argument. |

Every non-zero exit prints one actionable line naming the fix. Fail-closed: nothing ships partially
obfuscated, and a failed run leaves the build output exactly as the bundler wrote it.
