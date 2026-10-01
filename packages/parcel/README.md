# @afterpack/parcel-optimizer

A Parcel 2 optimizer (Parcel 2.9 and later) that obfuscates each JavaScript bundle in memory, using
the [AfterPack](https://www.afterpack.dev) JavaScript obfuscator. Parcel writes only the obfuscated
result.

## Install

```sh
npm install --save-dev @afterpack/parcel-optimizer
```

The name is `@afterpack/parcel-optimizer` because Parcel requires optimizer packages to be named
that way.

## Usage

```jsonc
// .parcelrc
{
  "extends": "@parcel/config-default",
  "optimizers": {
    "*.{js,mjs,cjs}": ["...", "@afterpack/parcel-optimizer"]
  }
}
```

Keep the `"..."`: it runs Parcel's own minifier first and AfterPack last. If obfuscation fails, the
build fails.

## Check a deploy

Add the plugin's reporter to the build command, and each build writes `.afterpack-protection.json`
into the target's output directory, a receipt with a hash per obfuscated bundle:

```sh
parcel build index.html --reporter @afterpack/parcel-optimizer/reporter
npx afterpack verify dist   # in the deploy step, before the upload
```

`afterpack verify` fails if a file changed after it was obfuscated, or if there is no receipt. The
reporter writes none when a bundle it shipped was not obfuscated in that build: the optimizer is
missing from `.parcelrc`, `build.autorun` is off, or Parcel reused the bundle from `.parcel-cache`.
Parcel's naming rule for plugins in `.parcelrc` leaves no place there for a reporter in this
package, so it goes on the command line.

## Configuration

`.parcelrc` cannot pass options, so put them in `afterpack.json` at your project root, or in
`AFTERPACK_*` environment variables, which win over the file:

```json
{
  "preset": "medium",
  "seed": "git"
}
```

| Key | What it does | Default |
| --- | --- | --- |
| [`preset`][preset] | `"minify"`, `"light"`, `"medium"`, `"hard"` or `"extreme"` | `"light"` |
| [`seed`][seed] | a number or string; `"git"` uses the current commit | a new random seed per build |
| [`identifiers.reserved`][identifiers.reserved] | names never to rename | none |
| [`paths.exclude`][paths.exclude] | globs for files to leave untouched | none |
| [`sourceMap.enabled`][sourceMap.enabled] | write source maps for the obfuscated output | on in development when an input map exists, off in production |
| [`protectionMap.enabled`][protectionMap.enabled] | write the Protection Map | on when the bundle has a source map |
| [`build.autorun`][build.autorun] | `false` turns AfterPack off | `true` |

Every other option is in the [configuration reference](https://www.afterpack.dev/docs/config). An
unknown or misspelled key fails the build and names the right spelling.

[preset]: https://www.afterpack.dev/docs/config#preset
[seed]: https://www.afterpack.dev/docs/config#seed
[identifiers.reserved]: https://www.afterpack.dev/docs/config#identifiers-reserved
[paths.exclude]: https://www.afterpack.dev/docs/config#paths-exclude
[sourceMap.enabled]: https://www.afterpack.dev/docs/config#sourceMap-enabled
[protectionMap.enabled]: https://www.afterpack.dev/docs/config#protectionMap-enabled
[build.autorun]: https://www.afterpack.dev/docs/config#build-autorun
[build.backup]: https://www.afterpack.dev/docs/config#build-backup
[paths.include]: https://www.afterpack.dev/docs/config#paths-include

The plugin writes one [Protection Map](https://www.afterpack.dev/docs/protection-map) per bundle to
`.afterpack/`, which carries its own `.gitignore` and self-ignores. It contains your original
source, so never deploy or commit it.

## Things to know

- **Seeds.** Parcel builds bundles in several worker processes. Set [`seed`][seed] (or `AFTERPACK_SEED`) to
  use one seed across the whole build.
- **Directives.** `/* @afterpack */` [directives](https://www.afterpack.dev/docs/directives) that
  raise protection for a region are a [Pro](https://www.afterpack.dev/docs/pro) feature. They are
  read back from the bundle's source map, so enable source maps on the target. Directives in your
  entry module usually cannot be recovered; move that code into an imported module.
- **Content hashes.** When Parcel targets browsers without native ES modules, it can put
  content-hash placeholders in string literals, and obfuscation would break the lazy-chunk URLs. The
  plugin detects this and fails the build. Build with `parcel build --no-content-hash`, or use
  `"preset": "minify"`. Parcel's default ES module output is not affected.
- **Cache.** Parcel caches optimizer output. Clear `.parcel-cache` for a fresh seed on an unchanged
  build.
- **Not available here:** [`build.backup`][build.backup] and [`paths.include`][paths.include].
- Parcel may print that ES module dependencies are experimental and that the plugin has
  non-statically analyzable dependencies. Both are harmless.

## Pro

Without a key, AfterPack runs on your machine with the full pipeline at any preset. Set
[`AFTERPACK_KEY`](https://www.afterpack.dev/docs/config#key) in your environment and the same
optimizer builds in AfterPack's cloud instead, which adds per-region
[directives](https://www.afterpack.dev/docs/directives) and two hardening transforms you can turn
on: self-integrity (anti-tamper) and comparison hardening. See [AfterPack
Pro](https://www.afterpack.dev/docs/pro).

## Links

- [Parcel setup guide](https://www.afterpack.dev/docs/frameworks/parcel)
- [Presets and protection levels](https://www.afterpack.dev/docs/presets)
- [How AfterPack compares to other obfuscators](https://www.afterpack.dev/docs/comparison)
- [Protecting paywall checks](https://www.afterpack.dev/docs/use-cases/paywall-checks)

## License

Apache-2.0. The engine it runs, `@afterpack/core`, has its own
[license](https://www.afterpack.dev/license).

## Feedback

Questions, suggestions and bug reports: [afterpack.dev/contact](https://www.afterpack.dev/contact).
You can also file a bug on [GitHub Issues](https://github.com/afterpack-dev/afterpack/issues).
