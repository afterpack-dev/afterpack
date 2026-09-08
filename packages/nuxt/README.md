# @afterpack/nuxt

AfterPack for **Nuxt 3** — obfuscates your production build output automatically. Nuxt bundles with
Vite, and AfterPack integrates at the bundler level, so this package is a thin, idiomatic **Nuxt module**
over [`@afterpack/vite`](../vite): add it to your `modules` and every emitted `.js` chunk is obfuscated
after Vite writes it, with a source map and a Protection Map dropped alongside.

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ["@afterpack/nuxt"],
  afterpack: {
    // seed, preset, complexity, protectionMap, regions, build.autorun, ... — see @afterpack/vite
    seed: "git",
  },
});
```

The module registers `@afterpack/vite` on Nuxt's Vite config via `addVitePlugin`, so the client bundle is
obfuscated in Vite's `generateBundle`, before the build is written. Every **configuration** option under the `afterpack` key is
forwarded verbatim to [`@afterpack/vite`](../vite) — see it for the full option reference and the
opt-out / production-flip policy. `@afterpack/vite`'s own `leg`/`projectRoot` are
Vite/Electron plumbing and are not part of this module's API.

## Static vs. server

- **Static / prerendered** (`nuxt generate`): the prerendered client bundle in `.output/public/_nuxt/`
  is obfuscated — the recommended shape for shipping protected client code.
- **Server (SSR)**: the client bundle is obfuscated the same way; the Nitro server bundle is your own
  deployment artifact.

Nuxt 2 (webpack) projects should use [`@afterpack/webpack`](../webpack) instead.

## Configuration

Options can also be set in `afterpack.json` — the one config file every AfterPack integration reads,
at the nearest ancestor of your working directory — or in an `AFTERPACK_<key>` environment variable.
Most specific wins: the options object here, then the environment, then the file. See
[`@afterpack/vite`](../vite#configuration) for the canonical names and the validation rules.
