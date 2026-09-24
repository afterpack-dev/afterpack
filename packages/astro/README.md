# @afterpack/astro

An Astro integration (Astro 4, 5 and 6) that obfuscates your production JavaScript, using the
[AfterPack](https://www.afterpack.dev) JavaScript obfuscator.

## Install

```sh
npm install --save-dev @afterpack/astro
```

## Usage

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import afterpack from "@afterpack/astro";

export default defineConfig({
  integrations: [afterpack()],
});
```

The default export and the named `afterpackAstro` export are the same function.

The integration adds AfterPack to Astro's Vite build. It obfuscates the JavaScript Astro ships to
the browser (islands and client scripts) and the server and prerender build of an `output: "server"`
or hybrid app. Every chunk is obfuscated before it is written, and a failed run fails the build.

## Options

```js
integrations: [afterpack({ preset: "medium", seed: "git" })],
```

Options are the same as [`@afterpack/vite`](https://www.npmjs.com/package/@afterpack/vite), except
`leg` and `projectRoot`, which Astro does not need.

The options you are most likely to set are [`preset`][preset], [`complexity`][complexity],
[`seed`][seed], [`identifiers.reserved`][identifiers.reserved] for names that must stay as they are,
[`paths.exclude`][paths.exclude] for files to leave alone, and [`build.autorun`][build.autorun] to
turn AfterPack off. Every other option is in the [configuration
reference](https://www.afterpack.dev/docs/config). Options can also live in `afterpack.json` or in
`AFTERPACK_*` environment variables. The options object wins over the environment, which wins over
the file.

[preset]: https://www.afterpack.dev/docs/config#preset
[complexity]: https://www.afterpack.dev/docs/config#complexity
[seed]: https://www.afterpack.dev/docs/config#seed
[identifiers.reserved]: https://www.afterpack.dev/docs/config#identifiers-reserved
[paths.exclude]: https://www.afterpack.dev/docs/config#paths-exclude
[build.autorun]: https://www.afterpack.dev/docs/config#build-autorun

## Pro

Without a key, AfterPack runs on your machine and applies basic protection. Set
[`AFTERPACK_KEY`](https://www.afterpack.dev/docs/config#key) in your environment and the same
integration sends the build to AfterPack's cloud, which applies much stronger protection. Keep the
key out of `astro.config.mjs`. See [AfterPack Pro](https://www.afterpack.dev/docs/pro).

## Links

- [Astro setup guide](https://www.afterpack.dev/docs/frameworks/astro)
- [Presets and protection levels](https://www.afterpack.dev/docs/presets)
- [How AfterPack compares to other obfuscators](https://www.afterpack.dev/docs/comparison)
- [Keeping API keys shipped in a bundle out of plain sight](https://www.afterpack.dev/docs/use-cases/shipped-api-keys)

## License

Apache-2.0. The engine it runs, `@afterpack/core`, has its own
[license](https://www.afterpack.dev/license).

## Feedback

Questions, suggestions and bug reports: [afterpack.dev/contact](https://www.afterpack.dev/contact).
You can also file a bug on [GitHub Issues](https://github.com/afterpack-dev/afterpack/issues).
