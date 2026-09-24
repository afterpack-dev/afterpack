# @afterpack/sveltekit

Obfuscate a SvelteKit build. `@afterpack/sveltekit` adds the
[AfterPack](https://www.afterpack.dev) JavaScript obfuscator to SvelteKit 1 and 2.

## Install

```sh
npm install --save-dev @afterpack/sveltekit
```

## Usage

```ts
// vite.config.ts
import { sveltekit } from "@sveltejs/kit/vite";
import { afterpackSveltekit } from "@afterpack/sveltekit";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [sveltekit(), afterpackSveltekit()],
});
```

Put `afterpackSveltekit()` after `sveltekit()`. Every JavaScript chunk your adapter's build
produces is obfuscated before Vite writes it, on both the client and the server build. A failed run
fails the build.

`afterpackSveltekit(options)` takes the same options as
[`@afterpack/vite`](https://www.npmjs.com/package/@afterpack/vite), for example
`afterpackSveltekit({ preset: "hard", seed: "git" })`.

The options you are most likely to set are [`preset`][preset], [`complexity`][complexity],
[`seed`][seed], [`identifiers.reserved`][identifiers.reserved] for names that must stay as they are,
[`paths.exclude`][paths.exclude] for files to leave alone, and [`build.autorun`][build.autorun] to
turn AfterPack off. Every other option is in the [configuration
reference](https://www.afterpack.dev/docs/config). Options can also live in `afterpack.json` or in
`AFTERPACK_*` environment variables.

[preset]: https://www.afterpack.dev/docs/config#preset
[complexity]: https://www.afterpack.dev/docs/config#complexity
[seed]: https://www.afterpack.dev/docs/config#seed
[identifiers.reserved]: https://www.afterpack.dev/docs/config#identifiers-reserved
[paths.exclude]: https://www.afterpack.dev/docs/config#paths-exclude
[build.autorun]: https://www.afterpack.dev/docs/config#build-autorun

For a Svelte app without Kit, use
[`@afterpack/svelte`](https://www.npmjs.com/package/@afterpack/svelte).

## Pro

Without a key, AfterPack runs on your machine and applies basic protection. Set
[`AFTERPACK_KEY`](https://www.afterpack.dev/docs/config#key) in your environment and the same plugin
sends the build to AfterPack's cloud, which applies much stronger protection. See [AfterPack
Pro](https://www.afterpack.dev/docs/pro).

## Links

- [SvelteKit setup guide](https://www.afterpack.dev/docs/frameworks/sveltekit)
- [Presets and protection levels](https://www.afterpack.dev/docs/presets)
- [How AfterPack compares to other obfuscators](https://www.afterpack.dev/docs/comparison)
- [Protecting paywall checks](https://www.afterpack.dev/docs/use-cases/paywall-checks)

## License

Apache-2.0. The engine it runs, `@afterpack/core`, has its own
[license](https://www.afterpack.dev/license).

## Feedback

Questions, suggestions and bug reports: [afterpack.dev/contact](https://www.afterpack.dev/contact).
You can also file a bug on [GitHub Issues](https://github.com/afterpack-dev/afterpack/issues).
