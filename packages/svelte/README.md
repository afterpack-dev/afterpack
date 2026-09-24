# @afterpack/svelte

Obfuscate a Svelte app's production build. `@afterpack/svelte` adds the
[AfterPack](https://www.afterpack.dev) JavaScript obfuscator to a Svelte 4 or 5 project built with
Vite.

## Install

```sh
npm install --save-dev @afterpack/svelte
```

## Usage

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { afterpackSvelte } from "@afterpack/svelte";

export default defineConfig({
  plugins: [svelte(), afterpackSvelte()],
});
```

Every JavaScript chunk is obfuscated before Vite writes it, and a failed run fails the build.

`afterpackSvelte(options)` takes the same options as
[`@afterpack/vite`](https://www.npmjs.com/package/@afterpack/vite), for example
`afterpackSvelte({ preset: "hard", seed: "git" })`. See the
[configuration reference](https://www.afterpack.dev/docs/config) for every key. Options can also
live in `afterpack.json` or in `AFTERPACK_*` environment variables.

For a SvelteKit app, use [`@afterpack/sveltekit`](https://www.npmjs.com/package/@afterpack/sveltekit).
For a component library bundled with Rollup, use
[`@afterpack/rollup`](https://www.npmjs.com/package/@afterpack/rollup).

## Pro

Without a key, AfterPack runs on your machine and applies basic protection. Set `AFTERPACK_KEY` in
your environment and the same plugin sends the build to AfterPack's cloud, which applies much
stronger protection. See [AfterPack Pro](https://www.afterpack.dev/docs/pro).

## Links

- [Svelte setup guide](https://www.afterpack.dev/docs/frameworks/svelte)
- [Presets and protection levels](https://www.afterpack.dev/docs/presets)
- [How AfterPack compares to other obfuscators](https://www.afterpack.dev/docs/comparison)
- [Hiding unreleased features in client code](https://www.afterpack.dev/docs/use-cases/unreleased-features)

## License

Apache-2.0. The engine it runs, `@afterpack/core`, has its own
[license](https://www.afterpack.dev/license).

## Feedback

Questions and ideas: [GitHub Discussions](https://github.com/afterpack-dev/afterpack/discussions).
Bugs: [GitHub Issues](https://github.com/afterpack-dev/afterpack/issues).
