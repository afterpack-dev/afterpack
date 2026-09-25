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

| Option | What it does | Default |
| --- | --- | --- |
| [`preset`][preset] | `"minify"`, `"light"`, `"medium"`, `"hard"` or `"extreme"` | `"light"` |
| [`seed`][seed] | a number or string; `"git"` uses the current commit | a new random seed per build |
| [`identifiers.reserved`][identifiers.reserved] | names never to rename | none |
| [`paths.exclude`][paths.exclude] | globs for files to leave untouched | none |
| [`sourceMap.enabled`][sourceMap.enabled] | write source maps for the obfuscated output | on in development when Vite emits a map, off in production |
| [`protectionMap.enabled`][protectionMap.enabled] | write the Protection Map | on when Vite emits source maps |
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

The [Protection Map](https://www.afterpack.dev/docs/protection-map) is written to `.afterpack/`,
which carries its own `.gitignore` and self-ignores. It contains your original source, so never
deploy or commit it.

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

Without a key, AfterPack runs on your machine and applies basic protection. Set
[`AFTERPACK_KEY`](https://www.afterpack.dev/docs/config#key) in your environment and the same plugin
sends the build to AfterPack's cloud, which applies much stronger protection. Keep the key out of
`vite.config.ts`: the plugin rejects it there, because the config is committed source. See
[AfterPack Pro](https://www.afterpack.dev/docs/pro).

## Not supported here

- [`build.backup`](https://www.afterpack.dev/docs/config#build-backup): the output is handed back to
  Vite in memory, so there is no file to back up.
- [`paths.include`](https://www.afterpack.dev/docs/config#paths-include): the plugin works on Vite's
  bundle and does not walk the output directory. Use the [`afterpack`
  CLI](https://www.npmjs.com/package/afterpack) if you need that.

## Links

- [Vite setup guide](https://www.afterpack.dev/docs/frameworks/vite)
- [Presets and protection levels](https://www.afterpack.dev/docs/presets)
- [How AfterPack compares to javascript-obfuscator and Jscrambler](https://www.afterpack.dev/docs/comparison)
- [Protecting paywall and license checks](https://www.afterpack.dev/docs/use-cases/paywall-checks)

## License

Apache-2.0. The engine it runs, `@afterpack/core`, has its own
[license](https://www.afterpack.dev/license).

## Feedback

Questions, suggestions and bug reports: [afterpack.dev/contact](https://www.afterpack.dev/contact).
You can also file a bug on [GitHub Issues](https://github.com/afterpack-dev/afterpack/issues).
