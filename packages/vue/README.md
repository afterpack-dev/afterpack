# @afterpack/vue

Obfuscate a Vue 3 app's production build. `@afterpack/vue` adds the
[AfterPack](https://www.afterpack.dev) JavaScript obfuscator to a Vue 3 project built with Vite.

## Install

```sh
npm install --save-dev @afterpack/vue
```

## Usage

```ts
// vite.config.ts
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { afterpackVue } from "@afterpack/vue";

export default defineConfig({
  plugins: [vue(), afterpackVue()],
});
```

Every JavaScript chunk is obfuscated before Vite writes it, and a failed run fails the build.

`afterpackVue(options)` takes the same options as
[`@afterpack/vite`](https://www.npmjs.com/package/@afterpack/vite), for example
`afterpackVue({ preset: "hard", seed: "git" })`. See the
[configuration reference](https://www.afterpack.dev/docs/config) for every key. Options can also
live in `afterpack.json` or in `AFTERPACK_*` environment variables.

Vue CLI projects build with webpack. Use
[`@afterpack/webpack`](https://www.npmjs.com/package/@afterpack/webpack) there. For Nuxt, use
[`@afterpack/nuxt`](https://www.npmjs.com/package/@afterpack/nuxt).

## Pro

Without a key, AfterPack runs on your machine and applies basic protection. Set `AFTERPACK_KEY` in
your environment and the same plugin sends the build to AfterPack's cloud, which applies much
stronger protection. See [AfterPack Pro](https://www.afterpack.dev/docs/pro).

## Links

- [Vue setup guide](https://www.afterpack.dev/docs/frameworks/vue)
- [Presets and protection levels](https://www.afterpack.dev/docs/presets)
- [How AfterPack compares to other obfuscators](https://www.afterpack.dev/docs/comparison)
- [Protecting pricing logic](https://www.afterpack.dev/docs/use-cases/pricing-logic)

## License

Apache-2.0. The engine it runs, `@afterpack/core`, has its own
[license](https://www.afterpack.dev/license).

## Feedback

Questions and ideas: [GitHub Discussions](https://github.com/afterpack-dev/afterpack/discussions).
Bugs: [GitHub Issues](https://github.com/afterpack-dev/afterpack/issues).
