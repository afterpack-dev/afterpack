# @afterpack/sveltekit

AfterPack for **SvelteKit** — obfuscates your production build output automatically. SvelteKit builds
with Vite, and AfterPack integrates at the bundler level, so this package is a thin, idiomatic wrapper
over [`@afterpack/vite`](../vite): add it to the `plugins` array in your `vite.config.ts` (the same
config SvelteKit already uses) and every emitted `.js` chunk is obfuscated before the bundler writes it,
with a source map and a Protection Map dropped alongside.

```ts
// vite.config.ts
import { sveltekit } from "@sveltejs/kit/vite";
import { afterpackSveltekit } from "@afterpack/sveltekit";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [sveltekit(), afterpackSveltekit()],
});
```

`afterpackSveltekit(options)` is exactly `afterpackVite(options)` — every **configuration** option (`seed`, `preset`,
`complexity`, `protectionMap`, `regions`, `directives`, `build.autorun`, …) is forwarded verbatim.
`@afterpack/vite`'s own `leg`/`projectRoot` are Vite/Electron plumbing and are not part of
this package's API. See
[`@afterpack/vite`](../vite) for the full option reference and the opt-out / production-flip policy.

## Notes

- Place `afterpackSveltekit()` **after** `sveltekit()` so it runs on the already-built output.
- The obfuscated surface is whatever your adapter emits as JS (e.g. `adapter-static`'s prerendered
  client bundle, or the Node/serverless server bundle). Server output is obfuscated too, since the plugin
  runs in `generateBundle`, over the bundle the build produced.
- Plain (non-Kit) Svelte apps: use [`@afterpack/svelte`](../svelte).

## Configuration

Options can also be set in `afterpack.json` — the one config file every AfterPack integration reads,
at the nearest ancestor of your working directory — or in an `AFTERPACK_<key>` environment variable.
Most specific wins: the options object here, then the environment, then the file. See
[`@afterpack/vite`](../vite#configuration) for the canonical names and the validation rules.
