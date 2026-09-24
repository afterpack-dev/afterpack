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
others), the plugin is the better fit: it obfuscates inside the build, so the readable bundle never
reaches disk. Run `afterpack` with no path and it tells you which plugin to install.

## `afterpack [path]`

Files are obfuscated in place. Build first, then run AfterPack once. A second run over the same
output is refused, because AfterPack recognises its own output.

Nested `node_modules/` folders are skipped. Pass [`--paths.include`][paths.include]`='**/node_modules/**'`
(quoted) to include them.

Each run writes:

- `.afterpack-protection.json` in the output directory, the receipt that `afterpack verify` checks.
- `.afterpack/backup/`, a copy of the original files, so `afterpack restore` can undo the run.
  Turn it off with [`--build.backup`][build.backup]`=false`.
- `.afterpack/protectionMap.html`, the [Protection Map](https://www.afterpack.dev/docs/protection-map),
  when your build has source maps.
- `.map` files next to the output, when your build has source maps and the run is not a production
  build.

The backup and the Protection Map contain your original source. AfterPack adds `.afterpack/` to the
nearest `.gitignore`. Never deploy or commit them.

With no path, `afterpack` looks at your project first. If it finds a framework, it prints the plugin
to install (or tells you the one you have already covers the build) and exits `1`. Otherwise it
picks the build output (`dist/`, `build/`, `out/`, `.output/` or `.next/`), says what it found and
runs. It never prompts.

## `afterpack verify [dir]`

Checks a build against its protection receipt. Run it in your deploy step.

```sh
npx afterpack@latest verify .        # looks in ./ and ./.next/
npx afterpack@latest verify dist
```

It exits `1` when the receipt is missing, belongs to a different build, or a file changed after it
was obfuscated. The CLI and the plugins for Vite, Next.js, webpack, Rollup, esbuild and Angular all
write a receipt.

## `afterpack restore [dir]`

Puts back the original files from `.afterpack/backup/`. A file that changed since the run is
skipped and named, and the command exits `1`.

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
| [`--complexity`][complexity] | a numeric protection level, overriding the preset's | the preset's value |
| [`--seed`][seed] | fix the seed; `git` uses the current commit | a new random seed per build |
| [`--paths.exclude`][paths.exclude] | globs to leave untouched | none |
| [`--paths.include`][paths.include] | globs to add back to the walk | none |
| [`--identifiers.reserved`][identifiers.reserved] | names never to rename | none |
| [`--build.backup`][build.backup] | back up originals to `.afterpack/backup/` | `true` |
| [`--sourceMap.enabled`][sourceMap.enabled] | write `.map` files | on when an input map exists, off in production |
| [`--protectionMap.enabled`][protectionMap.enabled] | write the Protection Map | on when an input map exists |
| [`--diagnostics.format`][diagnostics.format] | `text` or `json` | `text` |
| [`--allowUnobfuscated`][allowUnobfuscated] | ship a file AfterPack could not process, instead of failing | `false` |
| [`--telemetry.enabled`][telemetry.enabled] | report anonymous diagnostics when a build fails | `true` |

Each flag is also a key in `afterpack.json` and an `AFTERPACK_*` variable. Every other option, such
as [`diagnostics.level`][diagnostics.level] or [`build.autorun`][build.autorun], is in the
[configuration reference](https://www.afterpack.dev/docs/config). The
[CLI reference](https://www.afterpack.dev/docs/cli) covers the commands.

[preset]: https://www.afterpack.dev/docs/config#preset
[complexity]: https://www.afterpack.dev/docs/config#complexity
[seed]: https://www.afterpack.dev/docs/config#seed
[paths.exclude]: https://www.afterpack.dev/docs/config#paths-exclude
[paths.include]: https://www.afterpack.dev/docs/config#paths-include
[identifiers.reserved]: https://www.afterpack.dev/docs/config#identifiers-reserved
[build.backup]: https://www.afterpack.dev/docs/config#build-backup
[sourceMap.enabled]: https://www.afterpack.dev/docs/config#sourceMap-enabled
[protectionMap.enabled]: https://www.afterpack.dev/docs/config#protectionMap-enabled
[diagnostics.format]: https://www.afterpack.dev/docs/config#diagnostics-format
[allowUnobfuscated]: https://www.afterpack.dev/docs/config#allowUnobfuscated
[telemetry.enabled]: https://www.afterpack.dev/docs/config#telemetry-enabled
[diagnostics.level]: https://www.afterpack.dev/docs/config#diagnostics-level
[build.autorun]: https://www.afterpack.dev/docs/config#build-autorun
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
and sends everything else to stderr. Use it in CI and scripts. `verify` and `audit` support it too.

## Pro

Without a key, AfterPack runs on your machine and applies basic protection. Set
[`AFTERPACK_KEY`][key] in your environment (or [`key`][key] in `afterpack.json`) and the same
command sends the build to AfterPack's cloud, which applies much stronger protection. If the cloud
cannot be reached, the run fails; it never quietly ships weaker output. Never commit the key. See
[AfterPack Pro](https://www.afterpack.dev/docs/pro).

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | Failure. Nothing was changed, or `verify`, `restore` or `audit` failed. |
| `2` | Some files shipped unobfuscated. Only possible with [`allowUnobfuscated`][allowUnobfuscated]. |
| `3` | The size limit ([`inflation.max`][inflation.max]) stopped AfterPack before it reached the protection level. |
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
