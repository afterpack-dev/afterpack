# [AfterPack](https://www.afterpack.dev)

AfterPack obfuscates the JavaScript your build already emitted. It runs after the bundler, over the
output directory, and rewrites every emitted file in place — so what ships is not your source.

This repository holds the **CLI**, the **framework integrations** and the shared helpers they build
on, all under Apache-2.0. The obfuscation engine is `@afterpack/core`: a proprietary native engine,
free to use, installed as an ordinary npm dependency. Its source is not here.

## Try it

```bash
npx afterpack@latest dist/
```

Point it at your output directory (`dist/`, `build/`, `out/`, …) or at a single `.js`/`.mjs`/`.cjs`
file. A directory is walked recursively.

```bash
npx afterpack@latest dist/ --preset=hard --seed=git
npx afterpack@latest verify .            # re-check a build against its protection receipt
npx afterpack@latest --help              # every option, with its type and default
```

Presets run `minify` → `light` → `medium` → `hard` → `extreme`. Every option is spelled identically
in all four places it can be written: `--preset=hard` on the command line, `AFTERPACK_preset` in the
environment, `"preset": "hard"` in `afterpack.json`, and `preset` in a plugin's options object.

## Framework integrations

The CLI is the universal fallback and works on any output. A plugin is better where one exists: it
hooks the bundler directly, so the cleartext bundle is never written to disk at all.

| Package | Targets | Entry point |
| --- | --- | --- |
| [`@afterpack/vite`](packages/vite) | Vite 5–8 | `afterpackVite()` plugin |
| [`@afterpack/next`](packages/next) | Next.js 14+ | `withAfterpack()` config wrapper |
| [`@afterpack/webpack`](packages/webpack) | webpack 5 | `AfterpackWebpackPlugin` |
| [`@afterpack/rollup`](packages/rollup) | Rollup 3–4 | `afterpackRollup()` plugin |
| [`@afterpack/esbuild`](packages/esbuild) | esbuild 0.17+ | `afterpackEsbuild()` plugin |
| [`@afterpack/astro`](packages/astro) | Astro 4–6 | `afterpackAstro()` integration |
| [`@afterpack/svelte`](packages/svelte) | Svelte 4–5 on Vite | `afterpackSvelte()` plugin |
| [`@afterpack/sveltekit`](packages/sveltekit) | SvelteKit 1–2 | `afterpackSveltekit()` plugin |
| [`@afterpack/vue`](packages/vue) | Vue 3 on Vite | `afterpackVue()` plugin |
| [`@afterpack/nuxt`](packages/nuxt) | Nuxt 3 | Nuxt module |
| [`@afterpack/angular`](packages/angular) | Angular 17+ | `afterpackAngular()` postbuild pass |
| [`@afterpack/electron`](packages/electron) | Electron (electron-vite, Forge) | `afterpackElectron()` — one seed for main, preload and renderer |
| [`@afterpack/parcel-optimizer`](packages/parcel) | Parcel 2.9+ | Parcel optimizer |

Two packages are shared machinery rather than an integration:
[`@afterpack/integration-utils`](packages/integration-utils) owns the configuration registry, source
map discovery and the obfuscation pass every front door runs, and
[`@afterpack/protection-map`](packages/protection-map) renders the local HTML report that shows what
was protected and how heavily.

## Documentation

Full documentation — configuration reference, per-framework guides, the Protection Map, and the
Pro features — is at [www.afterpack.dev/docs](https://www.afterpack.dev/docs).

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the setup, the
release channels and the conventions this repository enforces.

## License

[Apache-2.0](LICENSE). The `@afterpack/core` engine is a separate, proprietary package under its
own licence.

## Feedback

Questions and proposals: https://github.com/afterpack-dev/afterpack/discussions · Bugs: https://github.com/afterpack-dev/afterpack/issues
