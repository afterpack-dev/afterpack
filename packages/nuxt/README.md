# @afterpack/nuxt

A Nuxt 3 module that obfuscates your production JavaScript, using the
[AfterPack](https://www.afterpack.dev) JavaScript obfuscator.

## Install

```sh
npm install --save-dev @afterpack/nuxt
```

## Usage

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ["@afterpack/nuxt"],
  afterpack: {
    seed: "git",
  },
});
```

The module adds AfterPack to Nuxt's Vite build, so every JavaScript chunk is obfuscated before it
is written. That covers the client bundle of a server-rendered app and the prerendered output of
`nuxt generate` in `.output/public/_nuxt/`. A failed run fails the build.

Options under the `afterpack` key are the same as
[`@afterpack/vite`](https://www.npmjs.com/package/@afterpack/vite), for example
`preset`, `complexity` and `seed`. See the
[configuration reference](https://www.afterpack.dev/docs/config) for every key. Options can also
live in `afterpack.json` or in `AFTERPACK_*` environment variables.

Nuxt 2 builds with webpack. Use [`@afterpack/webpack`](https://www.npmjs.com/package/@afterpack/webpack)
there.

## Pro

Without a key, AfterPack runs on your machine and applies basic protection. Set `AFTERPACK_KEY` in
your environment and the same module sends the build to AfterPack's cloud, which applies much
stronger protection. Keep the key out of `nuxt.config.ts`. See
[AfterPack Pro](https://www.afterpack.dev/docs/pro).

## Links

- [Nuxt setup guide](https://www.afterpack.dev/docs/frameworks/nuxt)
- [Presets and protection levels](https://www.afterpack.dev/docs/presets)
- [How AfterPack compares to other obfuscators](https://www.afterpack.dev/docs/comparison)
- [Stopping userscripts and extensions from patching your app](https://www.afterpack.dev/docs/use-cases/patching-tools)

## License

Apache-2.0. The engine it runs, `@afterpack/core`, has its own
[license](https://www.afterpack.dev/license).

## Feedback

Questions and ideas: [GitHub Discussions](https://github.com/afterpack-dev/afterpack/discussions).
Bugs: [GitHub Issues](https://github.com/afterpack-dev/afterpack/issues).
