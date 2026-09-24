# @afterpack/webpack

A webpack obfuscation plugin for webpack 5. It obfuscates your production JavaScript inside the
webpack build, using the [AfterPack](https://www.afterpack.dev) JavaScript obfuscator.

## Install

```sh
npm install --save-dev @afterpack/webpack
```

## Usage

```js
// webpack.config.mjs
import { AfterpackWebpackPlugin } from "@afterpack/webpack";

export default {
  // ...
  plugins: [new AfterpackWebpackPlugin()],
};
```

The plugin obfuscates each JavaScript asset your chunks produce at the last step before webpack
writes to disk, so the readable bundle is never written. Hot-update chunks and assets other plugins
copy in are left alone. If obfuscation fails, the build fails.

Subresource integrity plugins keep working: they hash the obfuscated files.

Each build writes a protection receipt, `.afterpack-protection.json`, into the output directory.
Run `npx afterpack verify dist` in your deploy step to check that what you ship is what was
obfuscated.

## Options

```js
new AfterpackWebpackPlugin({ preset: "hard", seed: "git" });
```

| Option | Type | Default |
| --- | --- | --- |
| `preset` | `"minify"`, `"light"`, `"medium"`, `"hard"`, `"extreme"` | `"light"` |
| `complexity` | `number` | the preset's value |
| `seed` | `number` or `string` (`"git"` uses the current commit) | a new random seed per build |
| `protectionMap` | `boolean` | on when `devtool` emits source maps |
| `sourceMap` | `boolean` | on in development when webpack emits a map, off in production |
| `sourceMap.emitUrl` | `boolean` | on in development, off in production |
| `directives` | `boolean` | `true` |
| `build.autorun` | `boolean` | `true`; `false` turns AfterPack off |
| `production` | `boolean` | detected from `NODE_ENV=production` or `CI=true` |

Dotted names are nested objects: `sourceMap.emitUrl` is `{ sourceMap: { emitUrl: true } }`. Every
other key in the [configuration reference](https://www.afterpack.dev/docs/config) works too.

`/* @afterpack */` [directives](https://www.afterpack.dev/docs/directives) in your source need a
`devtool` that emits source maps, such as `"source-map"`. Without one, the plugin skips them and
tells you.

The [Protection Map](https://www.afterpack.dev/docs/protection-map) is written to `.afterpack/`,
outside webpack's output, and the plugin adds its local artifacts to your `.gitignore`. It contains
your original source, so never deploy or commit it.

Options can also live in `afterpack.json` or in `AFTERPACK_*` environment variables. The options
object wins over the environment, which wins over the file. An unknown or misspelled key fails the
build and names the right spelling.

## Pro

Without a key, AfterPack runs on your machine and applies basic protection. Set `AFTERPACK_KEY` in
your environment and the same plugin sends the build to AfterPack's cloud, which applies much
stronger protection. Keep the key out of your webpack config: the plugin rejects it there. See
[AfterPack Pro](https://www.afterpack.dev/docs/pro).

## Not supported here

- `build.backup`: the output goes back to webpack in memory, so there is no file to back up.
- `paths.include`: the plugin works on webpack's assets and does not walk the output directory.

## Links

- [webpack setup guide](https://www.afterpack.dev/docs/frameworks/webpack)
- [Presets and protection levels](https://www.afterpack.dev/docs/presets)
- [A javascript-obfuscator alternative: how AfterPack compares](https://www.afterpack.dev/docs/comparison)
- [Protecting pricing logic](https://www.afterpack.dev/docs/use-cases/pricing-logic)

## License

Apache-2.0. The engine it runs, `@afterpack/core`, has its own
[license](https://www.afterpack.dev/license).

## Feedback

Questions and ideas: [GitHub Discussions](https://github.com/afterpack-dev/afterpack/discussions).
Bugs: [GitHub Issues](https://github.com/afterpack-dev/afterpack/issues).
