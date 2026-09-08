# @afterpack/vue

AfterPack for **Vue 3** — obfuscates your production build output automatically. Vue 3 apps build with
Vite, and AfterPack integrates at the bundler level, so this package is a thin, idiomatic wrapper over
[`@afterpack/vite`](../vite): add it to your Vite plugins and every emitted `.js` chunk is obfuscated
after the bundler writes it, with a source map and a Protection Map dropped alongside.

```ts
// vite.config.ts
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { afterpackVue } from "@afterpack/vue";

export default defineConfig({
  plugins: [vue(), afterpackVue()],
});
```

`afterpackVue(options)` is exactly `afterpackVite(options)` — every **configuration** option (`seed`, `preset`,
`complexity`, `protectionMap`, `regions`, `directives`, `build.autorun`, …) is forwarded verbatim.
`@afterpack/vite`'s own `leg`/`projectRoot` are Vite/Electron plumbing and are not part of
this package's API. See
[`@afterpack/vite`](../vite) for the full option reference and the opt-out / production-flip policy.

## Vue CLI (webpack)

Legacy **Vue CLI** projects build with webpack, not Vite. Use [`@afterpack/webpack`](../webpack) there
instead — this package targets the modern Vite path.

## Configuration

Options can also be set in `afterpack.json` — the one config file every AfterPack integration reads,
at the nearest ancestor of your working directory — or in an `AFTERPACK_<key>` environment variable.
Most specific wins: the options object here, then the environment, then the file. See
[`@afterpack/vite`](../vite#configuration) for the canonical names and the validation rules.
