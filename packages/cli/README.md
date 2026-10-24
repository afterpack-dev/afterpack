# afterpack

The command-line JavaScript obfuscator from [AfterPack](https://www.afterpack.dev). Run it after
your build, over the output directory, to protect JavaScript source code before you ship it. It
works with any bundler, or none.

```sh
npx afterpack@latest dist                  # a build directory, walked recursively
npx afterpack@latest dist/bundle.js        # or one .js, .mjs or .cjs file
npx afterpack@latest dist --preset=hard --seed=git
npx afterpack@latest verify .              # check a build before you deploy it
npx afterpack@latest restore               # undo the last run
npx afterpack@latest audit example.com     # scan a live site
```

Use `afterpack@latest` so `npx` does not pick up an old cached copy. `afterpack --help` lists the
common options and `afterpack --help --all` lists every one.

If your project uses a framework with an AfterPack plugin (Vite, Next.js, webpack, Nuxt, Astro and
others), the plugin is the better fit. Most plugins obfuscate inside the build, so the readable
bundle never reaches disk; the Next.js, esbuild and Angular integrations run right after the tool
writes its output. Run `afterpack` with no path and it tells you which plugin to install.

## `afterpack [path]`

Files are obfuscated in place. Build first, then run AfterPack once. A second run over the same
output is refused, because AfterPack recognises its own output.

On a Next.js, Angular, Vite or webpack build, AfterPack also renames each content-hashed file to
match its obfuscated bytes, and rewrites every reference to it in the HTML, manifests and other
chunks. A name never points at different bytes, so a cache can't serve a stale copy. On other output
with content-hashed names, the names stay as your bundler wrote them; for long-lived caching, use
your framework's plugin, or pin a constant [`--seed`][seed].

Nested `node_modules/` folders are skipped. Pass [`--paths.include`][paths.include]`='**/node_modules/**'`
(quoted) to include them.

Each run writes:

- `.afterpack/receipts/<output dir>.json` (`.afterpack/receipts/dist.json` for `dist`), the receipt
  that `afterpack verify` checks. Every run or plugin build into the same directory adds the files
  it wrote to that one receipt; a file no longer on disk drops out.
- `.afterpack/backups/<output dir>/`, a copy of the original files, so `afterpack restore` can
  undo the run. Each output directory has its own backup and its own lock, so parallel builds of
  different apps in one repository don't collide, and a second run over the same directory is
  refused while the first is still going. Versions of the CLI before this one kept a single backup in
  `.afterpack/backup/` and don't read the new location; this version still restores the old one.
  Turn it off with [`--build.backup`][build.backup]`=false`.
- `.afterpack/protectionMap.html`, the [Protection Map](https://www.afterpack.dev/docs/protection-map),
  when your build has source maps (outside CI, unless `protectionMap.enabled` is `true`).
- `.map` files next to the output, only when you ask for them with
  [`--sourceMap.enabled`][sourceMap.enabled] or run with `--build.mode=development` (or
  `NODE_ENV=development`) on a build that has source maps.

Every other run is a production run: it deletes your build's own source maps, hidden ones included,
and the `sourceMappingURL` comments that name them, so no original source ships beside the output.

`.afterpack/` sits next to your project's lockfile, `afterpack.json` or `.git` (failing those, its
`package.json`), otherwise beside the build directory, never inside it:
`cd public && npx afterpack@latest .` keeps it beside `public/`, and a `package.json` your build
emits, such as Nitro's `.output/server/package.json`, never moves it. A single file in a project
root that holds a lockfile, `afterpack.json` or `.git` keeps it in that root. The same place holds
every run's files whatever directory you run from, so a second run over the same output, or over
the same file, is refused from anywhere. A run fails if it finds a `.afterpack/` inside the output, and removes a
`.afterpack-protection.json` an older version left there.

The backup and the Protection Map contain your original source. `.afterpack/` carries its own
`.gitignore` and self-ignores. Never deploy or commit them.

With no path, `afterpack` looks at your project first. If it finds a framework, it prints the plugin
to install (or tells you the one you have already covers the build) and exits `1`. Otherwise it
picks the build output (`dist/`, `build/`, `out/`, `.output/` or `.next/`), says what it found and
runs. It never prompts.

## `afterpack verify [dir]`

Checks a build against its protection receipt in `.afterpack/receipts/`. Run it in your deploy
step.

```sh
npx afterpack@latest verify .        # looks in ./ and ./.next/
npx afterpack@latest verify dist
npx afterpack@latest verify build    # SvelteKit's adapter copy; also .output/public, out/
```

A directory a framework copied from its build output, such as SvelteKit's `build/`, Nuxt's
`.output/public/` or Next's `out/`, is checked against the receipt of the directory it copied.

It checks every file the receipt records: each must be there and hash to the value AfterPack wrote.
Other files in the tree are not checked. The success line counts the JavaScript files the receipt
doesn't list, such as a bundle you build without AfterPack into the same directory
(`✓ Verified 40 files · dist/ · 27 other JS files aren't in this receipt`); they never fail it.
For a Next.js build the count covers `.next/static/chunks/`.

It exits `1` when the receipt is missing, belongs to a different build, or a file changed after it
was obfuscated. The CLI and the plugins for Vite, Next.js, webpack, Rollup, esbuild and Angular all
write a receipt.

## `afterpack restore [dir]`

Puts back the original files from `.afterpack/backups/`, under their original names, and undoes a
run that stopped partway. A run that stopped partway is undone only while every file still holds
its original bytes or the bytes the run was about to write; once the output is rebuilt, the next
`afterpack` run discards that backup and says so. When only part of the output was rebuilt,
nothing is discarded or restored, and the run names the rebuilt files. A file that changed since
the run is named, nothing is restored, and the command exits `1`. Point restore at one build directory to
undo only the run over it.

Limits: AfterPack does not fsync what it writes, so a power loss during a run or a restore can
leave files that neither the backup nor `afterpack verify` can vouch for; rebuild after one.

## `afterpack audit <url>`

Scans a live site for leaked secrets, exposed source maps and unprotected JavaScript, and prints a
link to the full report. It sends only the URL and writes nothing. A finished scan exits `0` however
much it found. It is the [free website security scanner](https://www.afterpack.dev/security-scanner)
in your terminal; see [auditing a live site](https://www.afterpack.dev/docs/audit).

## Options

Every option has one name, written the same way everywhere:

- `--preset=hard` on the command line
- `AFTERPACK_preset=hard` in the environment (dots become underscores)
- `"preset": "hard"` in `afterpack.json`, the nearest one at or above the working directory

A flag wins over the environment, which wins over the file. A boolean flag on its own means `true`.
An unknown or misspelled option fails the run and names the right spelling.

| Flag | What it does | Default |
| --- | --- | --- |
| [`--preset`][preset] | `minify`, `light`, `medium`, `hard` or `extreme` | `light` |
| [`--seed`][seed] | fix the seed; `git` uses the current commit | a new random seed per build |
| [`--paths.exclude`][paths.exclude] | globs to leave untouched | none |
| [`--paths.include`][paths.include] | globs to add back to the walk | none |
| [`--identifiers.reserved`][identifiers.reserved] | names never to rename | none |
| [`--build.backup`][build.backup] | back up originals to `.afterpack/backups/` | `true` |
| [`--protectionMap.enabled`][protectionMap.enabled] | write the Protection Map | on when an input map exists, outside CI |

Each flag is also a key in `afterpack.json` and an `AFTERPACK_*` variable. Every other option is in
the [configuration reference](https://www.afterpack.dev/docs/config). The
[CLI reference](https://www.afterpack.dev/docs/cli) covers the commands.

[preset]: https://www.afterpack.dev/docs/config#preset
[seed]: https://www.afterpack.dev/docs/config#seed
[paths.exclude]: https://www.afterpack.dev/docs/config#paths-exclude
[paths.include]: https://www.afterpack.dev/docs/config#paths-include
[identifiers.reserved]: https://www.afterpack.dev/docs/config#identifiers-reserved
[build.backup]: https://www.afterpack.dev/docs/config#build-backup
[protectionMap.enabled]: https://www.afterpack.dev/docs/config#protectionMap-enabled
[sourceMap.enabled]: https://www.afterpack.dev/docs/config#sourceMap-enabled
[diagnostics.format]: https://www.afterpack.dev/docs/config#diagnostics-format
[inflation.max]: https://www.afterpack.dev/docs/config#inflation-max
[key]: https://www.afterpack.dev/docs/config#key

```json
{
  "preset": "hard",
  "seed": "git",
  "paths": { "exclude": ["dist/vendor/**"] },
  "identifiers": { "reserved": ["Hls"] }
}
```

[`--diagnostics.format`][diagnostics.format]`=json` prints exactly one JSON document on stdout
and sends everything else to stderr. Use it in CI and scripts. `verify`, `restore` and `audit`
support it too. Every document, failures included, starts with `"schemaVersion": 1`. Within one
`schemaVersion` fields are only ever added; a removal, rename or retype comes with a new
`schemaVersion` in a major release.

## Pro

Without a key, AfterPack runs on your machine with the full pipeline at any preset. Set
[`AFTERPACK_KEY`][key] in your environment (or [`key`][key] in `afterpack.json`) and the same
command builds in AfterPack's cloud instead, which adds two hardening transforms you can turn on:
self-integrity, which detects edits to its own check table only, not edits
elsewhere in your code, and comparison hardening. If the cloud cannot be reached, the run
fails; it never falls back to a local build. Never commit the key. See [AfterPack
Pro](https://www.afterpack.dev/docs/pro).

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | Failure. Nothing was changed, or `verify`, `restore` or `audit` failed. |
| `2` | Partial. Reserved for a quota-exhausted build; no build returns it today. |
| `3` | The size limit ([`inflation.max`][inflation.max]) stopped AfterPack before it reached the protection level. |
| `4` | A region directive that raises protection needs a Pro key. |
| `5` | A runtime-reflection pattern was not acknowledged. |
| `6` | An update is required. The CLI prints the install command to run. |
| `64` | Misuse: an unknown option or command, or a malformed value. |

Every failure prints one line that says how to fix it. A failed run leaves your build output as
your bundler wrote it.

## Links

- [Quickstart](https://www.afterpack.dev/docs/quickstart)
- [Obfuscate your build in CI](https://www.afterpack.dev/docs/builds)
- [How AfterPack compares to javascript-obfuscator and Jscrambler](https://www.afterpack.dev/docs/comparison)

## License

Apache-2.0. The engine it runs, `@afterpack/core`, has its own
[license](https://www.afterpack.dev/license).

## Feedback

Questions, suggestions and bug reports: [afterpack.dev/contact](https://www.afterpack.dev/contact).
You can also file a bug on [GitHub Issues](https://github.com/afterpack-dev/afterpack/issues).
