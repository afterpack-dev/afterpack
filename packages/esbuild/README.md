# @afterpack/esbuild

An esbuild plugin (esbuild 0.17 and later) that obfuscates your output when the build finishes,
using the [AfterPack](https://www.afterpack.dev) JavaScript obfuscator.

## Install

```sh
npm install --save-dev @afterpack/esbuild
```

## Usage

```ts
// build.ts
import { build } from "esbuild";
import { afterpackEsbuild } from "@afterpack/esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outdir: "dist",
  bundle: true,
  plugins: [afterpackEsbuild()],
});
```

Both `outdir` and `outfile` work. Builds with `write: false`, and builds that already failed, are
skipped. If obfuscation fails, the build fails.

esbuild has no hook to change output before it is written, so the plugin obfuscates the files right
after esbuild writes them. For a few milliseconds the readable files are on disk, and a failed run
leaves them there. If that matters to you, use a bundler with an in-memory plugin, such as
[`@afterpack/vite`](https://www.npmjs.com/package/@afterpack/vite) or
[`@afterpack/rollup`](https://www.npmjs.com/package/@afterpack/rollup).

Each build writes a protection receipt, `.afterpack-protection.json`, into the output directory.
Run `npx afterpack verify dist` in your deploy step to check that what you ship is what was
obfuscated.

## Options

```ts
afterpackEsbuild({ preset: "hard", seed: "git" });
```

| Option | What it does | Default |
| --- | --- | --- |
| [`preset`][preset] | `"minify"`, `"light"`, `"medium"`, `"hard"` or `"extreme"` | `"light"` |
| [`seed`][seed] | a number or string; `"git"` uses the current commit | a new random seed per build |
| [`identifiers.reserved`][identifiers.reserved] | names never to rename | none |
| [`paths.exclude`][paths.exclude] | globs for files to leave untouched | none |
| [`sourceMap.enabled`][sourceMap.enabled] | write source maps for the obfuscated output | on in development when esbuild emits a map, off in production |
| [`protectionMap.enabled`][protectionMap.enabled] | write the Protection Map | on when esbuild's `sourcemap` is set |
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

`/* @afterpack */` directives need esbuild's `sourcemap: true`, since they are read back from the
source map. Without it, the plugin skips them and tells you.

The [Protection Map](https://www.afterpack.dev/docs/protection-map) is written to `.afterpack/`,
which carries its own `.gitignore` and self-ignores. The Protection Map and any backups contain
your original source, so never deploy or commit them.

Options can also live in `afterpack.json` or in `AFTERPACK_*` environment variables. The options
object wins over the environment, which wins over the file. An unknown or misspelled key fails the
build and names the right spelling.

## Pro

Without a key, AfterPack runs on your machine and applies basic protection. Set
[`AFTERPACK_KEY`](https://www.afterpack.dev/docs/config#key) in your environment and the same plugin
sends the build to AfterPack's cloud, which applies much stronger protection. Keep the key out of
your build script: the plugin rejects it there. See [AfterPack
Pro](https://www.afterpack.dev/docs/pro).

## Links

- [esbuild setup guide](https://www.afterpack.dev/docs/frameworks/esbuild)
- [Presets and protection levels](https://www.afterpack.dev/docs/presets)
- [How AfterPack compares to other obfuscators](https://www.afterpack.dev/docs/comparison)
- [Protecting code that ships to browser extensions](https://www.afterpack.dev/docs/use-cases/browser-extensions)

## License

Apache-2.0. The engine it runs, `@afterpack/core`, has its own
[license](https://www.afterpack.dev/license).

## Feedback

Questions, suggestions and bug reports: [afterpack.dev/contact](https://www.afterpack.dev/contact).
You can also file a bug on [GitHub Issues](https://github.com/afterpack-dev/afterpack/issues).
