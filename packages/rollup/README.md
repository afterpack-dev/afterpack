# @afterpack/rollup

A Rollup plugin (Rollup 3 and 4) that obfuscates your output as part of the build, using the
[AfterPack](https://www.afterpack.dev) JavaScript obfuscator.

## Install

```sh
npm install --save-dev @afterpack/rollup
```

## Usage

```js
// rollup.config.js
import { afterpackRollup } from "@afterpack/rollup";

export default {
  input: "src/index.ts",
  output: { dir: "dist", format: "esm" },
  plugins: [afterpackRollup()],
};
```

The plugin runs last, after every other plugin, and obfuscates each JavaScript chunk before Rollup
writes it. The readable bundle never reaches disk. If obfuscation fails, the build fails and the
output directory is left untouched.

Each build writes a protection receipt, `.afterpack-protection.json`, into the output directory.
Run `npx afterpack verify dist` in your deploy step to check that what you ship is what was
obfuscated.

## Options

```js
afterpackRollup({ preset: "hard", seed: "git" });
```

| Option | What it does | Default |
| --- | --- | --- |
| [`preset`][preset] | `"minify"`, `"light"`, `"medium"`, `"hard"` or `"extreme"` | `"light"` |
| [`seed`][seed] | a number or string; `"git"` uses the current commit | a new random seed per build |
| [`identifiers.reserved`][identifiers.reserved] | names never to rename | none |
| [`paths.exclude`][paths.exclude] | globs for files to leave untouched | none |
| [`sourceMap.enabled`][sourceMap.enabled] | write source maps for the obfuscated output | on in development when Rollup emits a map, off in production |
| [`protectionMap.enabled`][protectionMap.enabled] | write the Protection Map | on when `output.sourcemap` is set |
| [`build.autorun`][build.autorun] | `false` turns AfterPack off | `true` |

Dotted names are nested objects: `sourceMap.enabled` is `{ sourceMap: { enabled: true } }`. Every
other option is in the [configuration reference](https://www.afterpack.dev/docs/config).

[preset]: https://www.afterpack.dev/docs/config#preset
[seed]: https://www.afterpack.dev/docs/config#seed
[identifiers.reserved]: https://www.afterpack.dev/docs/config#identifiers-reserved
[paths.exclude]: https://www.afterpack.dev/docs/config#paths-exclude
[sourceMap.enabled]: https://www.afterpack.dev/docs/config#sourceMap-enabled
[protectionMap.enabled]: https://www.afterpack.dev/docs/config#protectionMap-enabled
[build.autorun]: https://www.afterpack.dev/docs/config#build-autorun

`/* @afterpack */` directives in a multi-module bundle need `output.sourcemap: true`. Without it,
the plugin skips them and tells you.

The [Protection Map](https://www.afterpack.dev/docs/protection-map) is written to `.afterpack/`,
outside your output directory; that directory carries its own `.gitignore` and self-ignores. It
contains your original source, so never publish or commit it.

Options can also live in `afterpack.json` or in `AFTERPACK_*` environment variables. The options
object wins over the environment, which wins over the file. An unknown or misspelled key fails the
build and names the right spelling.

## Pro

Without a key, AfterPack runs on your machine and applies basic protection. Set
[`AFTERPACK_KEY`](https://www.afterpack.dev/docs/config#key) in your environment and the same plugin
sends the build to AfterPack's cloud, which applies much stronger protection. Keep the key out of
your Rollup config: the plugin rejects it there. See [AfterPack
Pro](https://www.afterpack.dev/docs/pro).

## Not supported here

- [`build.backup`](https://www.afterpack.dev/docs/config#build-backup): the output goes back to
  Rollup in memory, so there is no file to back up.
- [`paths.include`](https://www.afterpack.dev/docs/config#paths-include): the plugin works on
  Rollup's bundle and does not walk the output directory.

## Links

- [Rollup setup guide](https://www.afterpack.dev/docs/frameworks/rollup)
- [Presets and protection levels](https://www.afterpack.dev/docs/presets)
- [How AfterPack compares to other obfuscators](https://www.afterpack.dev/docs/comparison)
- [Keeping API keys shipped in a bundle out of plain sight](https://www.afterpack.dev/docs/use-cases/shipped-api-keys)

## License

Apache-2.0. The engine it runs, `@afterpack/core`, has its own
[license](https://www.afterpack.dev/license).

## Feedback

Questions, suggestions and bug reports: [afterpack.dev/contact](https://www.afterpack.dev/contact).
You can also file a bug on [GitHub Issues](https://github.com/afterpack-dev/afterpack/issues).
