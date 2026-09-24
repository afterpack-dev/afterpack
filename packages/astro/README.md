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
`leg` and `projectRoot`, which Astro does not need. See the
[configuration reference](https://www.afterpack.dev/docs/config) for every key. Options can also
live in `afterpack.json` or in `AFTERPACK_*` environment variables. The options object wins over
the environment, which wins over the file.

## Pro

Without a key, AfterPack runs on your machine and applies basic protection. Set `AFTERPACK_KEY` in
your environment and the same integration sends the build to AfterPack's cloud, which applies much
stronger protection. Keep the key out of `astro.config.mjs`. See
[AfterPack Pro](https://www.afterpack.dev/docs/pro).

## Links

- [Astro setup guide](https://www.afterpack.dev/docs/frameworks/astro)
- [Presets and protection levels](https://www.afterpack.dev/docs/presets)
- [How AfterPack compares to other obfuscators](https://www.afterpack.dev/docs/comparison)
- [Keeping API keys shipped in a bundle out of plain sight](https://www.afterpack.dev/docs/use-cases/shipped-api-keys)

## License

Apache-2.0. The engine it runs, `@afterpack/core`, has its own
[license](https://www.afterpack.dev/license).

## Feedback

Questions and ideas: [GitHub Discussions](https://github.com/afterpack-dev/afterpack/discussions).
Bugs: [GitHub Issues](https://github.com/afterpack-dev/afterpack/issues).
