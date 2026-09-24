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

| Option | Type | Default |
| --- | --- | --- |
| `preset` | `"minify"`, `"light"`, `"medium"`, `"hard"`, `"extreme"` | `"light"` |
| `complexity` | `number` | the preset's value |
| `seed` | `number` or `string` (`"git"` uses the current commit) | a new random seed per build |
| `protectionMap` | `boolean` | on when `output.sourcemap` is set |
| `sourceMap` | `boolean` | on in development when Rollup emits a map, off in production |
| `sourceMap.emitUrl` | `boolean` | on in development, off in production |
| `directives` | `boolean` | `true` |
| `build.autorun` | `boolean` | `true`; `false` turns AfterPack off |
| `production` | `boolean` | detected from `NODE_ENV=production` or `CI=true` |

Dotted names are nested objects: `sourceMap.emitUrl` is `{ sourceMap: { emitUrl: true } }`. Every
other key in the [configuration reference](https://www.afterpack.dev/docs/config) works too.

`/* @afterpack */` directives in a multi-module bundle need `output.sourcemap: true`. Without it,
the plugin skips them and tells you.

The [Protection Map](https://www.afterpack.dev/docs/protection-map) is written to `.afterpack/`,
outside your output directory, and the plugin adds its local artifacts to your `.gitignore`. It
contains your original source, so never publish or commit it.

Options can also live in `afterpack.json` or in `AFTERPACK_*` environment variables. The options
object wins over the environment, which wins over the file. An unknown or misspelled key fails the
build and names the right spelling.

## Pro

Without a key, AfterPack runs on your machine and applies basic protection. Set `AFTERPACK_KEY` in
your environment and the same plugin sends the build to AfterPack's cloud, which applies much
stronger protection. Keep the key out of your Rollup config: the plugin rejects it there. See
[AfterPack Pro](https://www.afterpack.dev/docs/pro).

## Not supported here

- `build.backup`: the output goes back to Rollup in memory, so there is no file to back up.
- `paths.include`: the plugin works on Rollup's bundle and does not walk the output directory.

## Links

- [Rollup setup guide](https://www.afterpack.dev/docs/frameworks/rollup)
- [Presets and protection levels](https://www.afterpack.dev/docs/presets)
- [How AfterPack compares to other obfuscators](https://www.afterpack.dev/docs/comparison)
- [Keeping API keys shipped in a bundle out of plain sight](https://www.afterpack.dev/docs/use-cases/shipped-api-keys)

## License

Apache-2.0. The engine it runs, `@afterpack/core`, has its own
[license](https://www.afterpack.dev/license).

## Feedback

Questions and ideas: [GitHub Discussions](https://github.com/afterpack-dev/afterpack/discussions).
Bugs: [GitHub Issues](https://github.com/afterpack-dev/afterpack/issues).
