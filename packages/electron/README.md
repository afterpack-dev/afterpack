# @afterpack/electron

Electron app source protection for electron-vite and Electron Forge. `@afterpack/electron`
obfuscates the main, preload and renderer bundles of one app with one shared seed, using the
[AfterPack](https://www.afterpack.dev) JavaScript obfuscator.

## Install

```sh
npm install --save-dev @afterpack/electron
```

## electron-vite

Wrap your config once:

```ts
// electron.vite.config.ts
import { withAfterpack } from "@afterpack/electron";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default withAfterpack(
  defineConfig({
    main: { plugins: [externalizeDepsPlugin()] },
    preload: { plugins: [externalizeDepsPlugin()] },
    renderer: {},
  }),
);
```

`withAfterpack` adds AfterPack to each of `main`, `preload` and `renderer` that your config has, and
prints which ones it wired. Each bundle is obfuscated before Vite writes it. If obfuscation fails,
the build fails.

## Electron Forge with Vite

Forge loads each Vite config separately, so add the plugin to each one and name the part it builds:

```ts
// vite.main.config.ts (and the same in vite.preload and vite.renderer, with their leg)
import { afterpackElectron } from "@afterpack/electron";

export default { plugins: [afterpackElectron({ leg: "main" })] };
```

`leg` is required and is one of `"main"`, `"preload"` or `"renderer"`.

## One seed for the whole app

Every part of one build shares one seed, so main, preload and renderer are obfuscated as one
program. A new seed is drawn for each build. When your build script runs each part as a separate
command, there is no shared process, so pin the seed in the environment:

```sh
AFTERPACK_SEED=git npm run build
```

## Other toolchains

| Toolchain | Setup |
| --- | --- |
| electron-vite | `withAfterpack(defineConfig({ ... }))` |
| Electron Forge + Vite | `afterpackElectron({ leg })` in each config |
| Electron Forge + webpack | [`@afterpack/webpack`](https://www.npmjs.com/package/@afterpack/webpack) in each config |
| vite-plugin-electron | `afterpackElectron({ leg: "renderer" })`, placed last |
| electron-builder | packages, does not bundle; set up the bundler it packages |
| separate build commands | one plugin per part, with `AFTERPACK_SEED` set |

## Keep local files out of app.asar

AfterPack writes its Protection Map to `.afterpack/`. It contains your original source, so exclude
it from the packaged app. The plugin prints this reminder when it finds a packager config:

```jsonc
// electron-builder
"files": ["**/*", "!.afterpack/**", "!**/*.backup.*", "!**/*.map"]
// Electron Forge
packagerConfig: { ignore: [/^\/\.afterpack/, /\.backup\./, /\.map$/] }
```

## Options

```ts
withAfterpack(config, { preset: "hard", seed: "git" });
```

| Option | What it does | Default |
| --- | --- | --- |
| [`preset`][preset] | `"minify"`, `"light"`, `"medium"`, `"hard"` or `"extreme"` | `"light"` |
| [`complexity`][complexity] | a numeric protection level, overriding the preset's | the preset's value |
| [`seed`][seed] | a number or string; `"git"` uses the current commit | a new random seed per build, shared by every part |
| [`identifiers.reserved`][identifiers.reserved] | names never to rename | none |
| [`protectionMap.enabled`][protectionMap.enabled] | write the Protection Map, one per part in `.afterpack/<leg>/` | on when Vite emits source maps |
| [`build.autorun`][build.autorun] | `false` turns AfterPack off | `true` |
| `leg` | plugin option: `"main"`, `"preload"` or `"renderer"`; required for `afterpackElectron` | set by `withAfterpack` |
| `projectRoot` | plugin option: the app root that ties the parts into one build | `process.cwd()` |

Every other [`@afterpack/vite`](https://www.npmjs.com/package/@afterpack/vite) option works too, and
every other option is in the [configuration reference](https://www.afterpack.dev/docs/config).
Options can also live in `afterpack.json` or in `AFTERPACK_*` environment variables.

[preset]: https://www.afterpack.dev/docs/config#preset
[complexity]: https://www.afterpack.dev/docs/config#complexity
[seed]: https://www.afterpack.dev/docs/config#seed
[identifiers.reserved]: https://www.afterpack.dev/docs/config#identifiers-reserved
[protectionMap.enabled]: https://www.afterpack.dev/docs/config#protectionMap-enabled
[build.autorun]: https://www.afterpack.dev/docs/config#build-autorun
[build.backup]: https://www.afterpack.dev/docs/config#build-backup
[sourceMap.enabled]: https://www.afterpack.dev/docs/config#sourceMap-enabled

## What the plugin refuses

- electron-vite's `bytecodePlugin` on the same part, or `.jsc` files in the output: the build fails.
  Bytecode replaces the bundle AfterPack would protect, so the two cannot be combined.
- [`build.backup`][build.backup] set to `true`: the build fails, because the backup would hold your
  original source inside `app.asar`.
- [Source maps][sourceMap.enabled] turned on: a warning, since a map inside `app.asar` gives your
  source away.

## Pro

Without a key, AfterPack runs on your machine and applies basic protection. Set
[`AFTERPACK_KEY`](https://www.afterpack.dev/docs/config#key) in your environment and the same plugin
sends the build to AfterPack's cloud, which applies much stronger protection. Keep the key out of
your Vite config. See [AfterPack Pro](https://www.afterpack.dev/docs/pro).

## Links

- [Electron setup guide](https://www.afterpack.dev/docs/frameworks/electron)
- [Protect an Electron app's license check](https://www.afterpack.dev/docs/use-cases/electron-license-logic)
- [Presets and protection levels](https://www.afterpack.dev/docs/presets)
- [How AfterPack compares to other obfuscators](https://www.afterpack.dev/docs/comparison)

## License

Apache-2.0. The engine it runs, `@afterpack/core`, has its own
[license](https://www.afterpack.dev/license).

## Feedback

Questions, suggestions and bug reports: [afterpack.dev/contact](https://www.afterpack.dev/contact).
You can also file a bug on [GitHub Issues](https://github.com/afterpack-dev/afterpack/issues).
