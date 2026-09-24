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

## Configuration

`.parcelrc` cannot pass options, so put them in `afterpack.json` at your project root, or in
`AFTERPACK_*` environment variables, which win over the file:

```json
{
  "preset": "medium",
  "seed": "git"
}
```

| Key | Type | Default |
| --- | --- | --- |
| `preset` | `"minify"`, `"light"`, `"medium"`, `"hard"`, `"extreme"` | `"light"` |
| `complexity` | `number` | the preset's value |
| `seed` | `number` or `string` (`"git"` uses the current commit) | a new random seed per build |
| `protectionMap.enabled` | `boolean` | on when the bundle has a source map |
| `sourceMap.enabled` | `boolean` | on in development when an input map exists, off in production |
| `directives` | `boolean` | `true` |
| `build.autorun` | `boolean` | `true`; `false` turns AfterPack off |
| `production` | `boolean` | detected from `parcel build`, `NODE_ENV=production` or `CI=true` |

See the [configuration reference](https://www.afterpack.dev/docs/config) for every key. An unknown
or misspelled key fails the build and names the right spelling.

The plugin writes one [Protection Map](https://www.afterpack.dev/docs/protection-map) per bundle to
`.afterpack/` and adds it to your `.gitignore`. It contains your original source, so never deploy
or commit it.

## Things to know

- **Seeds.** Parcel builds bundles in several worker processes. Set `seed` (or `AFTERPACK_SEED`) to
  use one seed across the whole build.
- **Directives.** `/* @afterpack */` comments are read back from the bundle's source map, so enable
  source maps on the target. Directives in your entry module usually cannot be recovered; move that
  code into an imported module.
- **Content hashes.** When Parcel targets browsers without native ES modules, it can put
  content-hash placeholders in string literals, and obfuscation would break the lazy-chunk URLs. The
  plugin detects this and fails the build. Build with `parcel build --no-content-hash`, or use
  `"preset": "minify"`. Parcel's default ES module output is not affected.
- **Cache.** Parcel caches optimizer output. Clear `.parcel-cache` for a fresh seed on an unchanged
  build.
- **Not available here:** `build.backup` and `paths.include`, and there is no protection receipt, so
  `afterpack verify` has nothing to check on a Parcel build.
- Parcel may print that ES module dependencies are experimental and that the plugin has
  non-statically analyzable dependencies. Both are harmless.

## Pro

Without a key, AfterPack runs on your machine and applies basic protection. Set `AFTERPACK_KEY` in
your environment and the same optimizer sends the build to AfterPack's cloud, which applies much
stronger protection. See [AfterPack Pro](https://www.afterpack.dev/docs/pro).

## Links

- [Parcel setup guide](https://www.afterpack.dev/docs/frameworks/parcel)
- [Presets and protection levels](https://www.afterpack.dev/docs/presets)
- [How AfterPack compares to other obfuscators](https://www.afterpack.dev/docs/comparison)
- [Protecting paywall checks](https://www.afterpack.dev/docs/use-cases/paywall-checks)

## License

Apache-2.0. The engine it runs, `@afterpack/core`, has its own
[license](https://www.afterpack.dev/license).

## Feedback

Questions and ideas: [GitHub Discussions](https://github.com/afterpack-dev/afterpack/discussions).
Bugs: [GitHub Issues](https://github.com/afterpack-dev/afterpack/issues).
