# @afterpack/vite

A Vite plugin that obfuscates your production JavaScript as part of `vite build`. It is the
[AfterPack](https://www.afterpack.dev) JavaScript obfuscator for Vite.

## Install

```sh
npm install --save-dev @afterpack/vite
```

## Usage

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { afterpackVite } from "@afterpack/vite";

export default defineConfig({
  plugins: [afterpackVite()],
});
```

The plugin obfuscates every JavaScript chunk in the bundle before Vite writes it, so the readable
bundle never reaches disk. If obfuscation fails, the build fails and your output directory is left
untouched.

Files Vite copies as-is from `publicDir` are not part of the bundle and are not obfuscated. Import
anything you want protected.

Each build writes a protection receipt, `.afterpack-protection.json`, into the output directory.
Run `npx afterpack verify dist` in your deploy step to check that what you ship is what was
obfuscated.

## Options

```ts
afterpackVite({ preset: "hard", seed: "git" });
```

| Option | Type | Default |
| --- | --- | --- |
| `preset` | `"minify"`, `"light"`, `"medium"`, `"hard"`, `"extreme"` | `"light"` |
| `complexity` | `number` | the preset's value |
| `seed` | `number` or `string` (`"git"` uses the current commit) | a new random seed per build |
| `protectionMap` | `boolean` | on when Vite emits source maps |
| `sourceMap` | `boolean` | on in development when Vite emits a map, off in production |
| `sourceMap.emitUrl` | `boolean` | on in development, off in production |
| `directives` | `boolean` | `true` |
| `build.autorun` | `boolean` | `true`; `false` turns AfterPack off |
| `production` | `boolean` | detected from `NODE_ENV=production` or `CI=true` |
| `leg` | `string` | none; names one build when an app runs Vite several times |
| `projectRoot` | `string` | Vite's `root` |

Dotted names are nested objects: `sourceMap.emitUrl` is `{ sourceMap: { emitUrl: true } }`. Every
other key in the [configuration reference](https://www.afterpack.dev/docs/config) works too, such as
`identifiers.reserved` or `paths.exclude`.

The [Protection Map](https://www.afterpack.dev/docs/protection-map) is written to `.afterpack/`,
and the plugin adds `.afterpack/` and its other local artifacts to your `.gitignore`. It contains
your original source, so never deploy or commit it.

Options can also live in `afterpack.json` or in `AFTERPACK_*` environment variables. The options
object wins over the environment, which wins over the file. An unknown or misspelled key fails the
build and names the right spelling.

## Several Vite builds in one app

Electron and SSR apps can run Vite more than once per build. Give each run a `leg` name
(`"main"`, `"renderer"`, `"server"`) so all of them share one seed and keep separate Protection
Maps under `.afterpack/<leg>/`. Set `projectRoot` when Vite's `root` is a subfolder of the app. When
the runs are separate processes, pin the seed with `AFTERPACK_SEED=git`. For Electron, use
[`@afterpack/electron`](https://www.npmjs.com/package/@afterpack/electron), which sets this up for
you.

## Pro

Without a key, AfterPack runs on your machine and applies basic protection. Set `AFTERPACK_KEY` in
your environment and the same plugin sends the build to AfterPack's cloud, which applies much
stronger protection. Keep the key out of `vite.config.ts`: the plugin rejects it there, because the
config is committed source. See [AfterPack Pro](https://www.afterpack.dev/docs/pro).

## Not supported here

- `build.backup`: the output is handed back to Vite in memory, so there is no file to back up.
- `paths.include`: the plugin works on Vite's bundle and does not walk the output directory. Use
  the [`afterpack` CLI](https://www.npmjs.com/package/afterpack) if you need that.

## Links

- [Vite setup guide](https://www.afterpack.dev/docs/frameworks/vite)
- [Presets and protection levels](https://www.afterpack.dev/docs/presets)
- [How AfterPack compares to javascript-obfuscator and Jscrambler](https://www.afterpack.dev/docs/comparison)
- [Protecting paywall and license checks](https://www.afterpack.dev/docs/use-cases/paywall-checks)

## License

Apache-2.0. The engine it runs, `@afterpack/core`, has its own
[license](https://www.afterpack.dev/license).

## Feedback

Questions and ideas: [GitHub Discussions](https://github.com/afterpack-dev/afterpack/discussions).
Bugs: [GitHub Issues](https://github.com/afterpack-dev/afterpack/issues).
