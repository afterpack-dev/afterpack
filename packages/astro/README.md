# @afterpack/astro

AfterPack for **Astro** — obfuscates your production build output automatically. Astro compiles every
island/client bundle through its own Vite pipeline, so this package is a real (thin) **Astro
integration**: drop it into `integrations` and it wires [`@afterpack/vite`](../vite) into Astro's Vite
config for you via the `astro:config:setup` hook. Every client chunk is then obfuscated **inside the
bundler's own pipeline**, before a byte of it reaches disk, with a Protection Map dropped beside your
project.

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import afterpack from "@afterpack/astro";

export default defineConfig({
  integrations: [afterpack()],
});
```

The default export and the named `afterpackAstro` export are the same function. Every
**configuration** option is forwarded verbatim to `@afterpack/vite`; its own
`leg`/`projectRoot` are Vite/Electron plumbing and are not part of this integration's API:

```js
integrations: [afterpack({ seed: "git", preset: "medium" })],
```

See [`@afterpack/vite`](../vite) for the full option reference and the opt-out / production-flip policy.

## How it works

Instead of asking you to hand-wire `vite: { plugins: [afterpackVite()] }` in your Astro config, the
integration calls `updateConfig({ vite: { plugins: [afterpackVite(options)] } })` inside
`astro:config:setup`, scoped to Astro's **client** environment. That is the whole package — zero
obfuscation logic of its own. This mirrors the manual approach the [`@afterpack/vite`](../vite) README
documents for Astro, just packaged as a one-line integration.

## Scope

The obfuscated surface is the JS Astro ships to a browser: island bundles and client scripts.
Server-rendered `.astro` template logic that never reaches a browser is out of scope.

Astro's SSR/prerender build is out of scope for a second, concrete reason. Astro finishes that build
with a post-build pass of its own: it captures each chunk, substitutes `@@ASTRO_MANIFEST_REPLACE@@`
in the captured text by raw string replacement, and writes the result back over whatever is on disk.
No obfuscator survives that — obfuscate before it and the placeholder is encoded away, so the
manifest is never injected; obfuscate after it and Astro has already overwritten the file with its
own cleartext copy. Rather than report a protected server build it did not deliver, this integration
does not claim that surface. If your Astro app runs `output: "server"` and you need the server bundle
protected too, say so — it needs engine-side literal preservation, which is tracked.

## Configuration

Options can also be set in `afterpack.json` — the one config file every AfterPack integration reads,
at the nearest ancestor of your working directory — or in an `AFTERPACK_<key>` environment variable.
Most specific wins: the options object here, then the environment, then the file. See
[`@afterpack/vite`](../vite#configuration) for the canonical names and the validation rules.

## Feedback

Questions and proposals: https://github.com/afterpack-dev/afterpack/discussions · Bugs: https://github.com/afterpack-dev/afterpack/issues
