# [AfterPack](https://www.afterpack.dev)

AfterPack is a JavaScript obfuscator that runs on your build output. Add it to your bundler, or
run it after the build, and what you ship is protected code instead of readable source.

This repository holds the `afterpack` CLI and the framework plugins, all under Apache-2.0. The
engine they run, `@afterpack/core`, is a separate npm package with its own
[license](https://www.afterpack.dev/license).

## Try it

```bash
npx afterpack@latest dist
```

Point it at your output directory (`dist/`, `build/`, `out/`) or a single `.js`, `.mjs` or `.cjs`
file. `npx afterpack@latest verify .` checks a build before you deploy it, and `--help` lists the
options.

Presets go from `minify` through `light`, `medium` and `hard` to `extreme`. Every option has one
name everywhere: `--preset=hard` on the command line, `AFTERPACK_preset=hard` in the environment,
`"preset": "hard"` in `afterpack.json`, and `preset` in a plugin's options.

Without a key, AfterPack runs locally and applies basic protection. With a
[Pro](https://www.afterpack.dev/docs/pro) key, the same packages send the build to AfterPack's
cloud, which applies much stronger protection. To try it without installing anything, use the
[playground](https://www.afterpack.dev/playground).

## Framework plugins

A plugin obfuscates inside the build, so the readable bundle never reaches disk. Use one where it
exists, and the CLI everywhere else.

| Package | Works with | Entry point |
| --- | --- | --- |
| [`@afterpack/vite`](packages/vite) | Vite 5 to 8 | `afterpackVite()` |
| [`@afterpack/next`](packages/next) | Next.js 15.4+ | `withAfterpack()` |
| [`@afterpack/webpack`](packages/webpack) | webpack 5 | `AfterpackWebpackPlugin` |
| [`@afterpack/rollup`](packages/rollup) | Rollup 3 and 4 | `afterpackRollup()` |
| [`@afterpack/esbuild`](packages/esbuild) | esbuild 0.17+ | `afterpackEsbuild()` |
| [`@afterpack/astro`](packages/astro) | Astro 4 to 6 | `afterpackAstro()` |
| [`@afterpack/svelte`](packages/svelte) | Svelte 4 and 5 on Vite | `afterpackSvelte()` |
| [`@afterpack/sveltekit`](packages/sveltekit) | SvelteKit 1 and 2 | `afterpackSveltekit()` |
| [`@afterpack/vue`](packages/vue) | Vue 3 on Vite | `afterpackVue()` |
| [`@afterpack/nuxt`](packages/nuxt) | Nuxt 3 | Nuxt module |
| [`@afterpack/angular`](packages/angular) | Angular 17+ | `afterpackAngular()` after `ng build` |
| [`@afterpack/electron`](packages/electron) | electron-vite, Electron Forge | `withAfterpack()`, `afterpackElectron()` |
| [`@afterpack/parcel-optimizer`](packages/parcel) | Parcel 2.9+ | Parcel optimizer |

Two more packages support the others: [`@afterpack/protection-map`](packages/protection-map)
renders the local [Protection Map](https://www.afterpack.dev/docs/protection-map) report, and
[`@afterpack/integration-utils`](packages/integration-utils) is internal code the CLI and plugins
share.

## Documentation

- [Quickstart](https://www.afterpack.dev/docs/quickstart)
- [Framework guides](https://www.afterpack.dev/docs/frameworks)
- [Configuration reference](https://www.afterpack.dev/docs/config)
- [How AfterPack compares to javascript-obfuscator and Jscrambler](https://www.afterpack.dev/docs/comparison)
- [Why AI deobfuscation changes what obfuscation has to do](https://www.afterpack.dev/blog/ai-deobfuscates-javascript)

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and
conventions.

## License

[Apache-2.0](LICENSE). The `@afterpack/core` engine is a separate package under its own
[license](https://www.afterpack.dev/license).

## Feedback

Questions and ideas: [GitHub Discussions](https://github.com/afterpack-dev/afterpack/discussions).
Bugs: [GitHub Issues](https://github.com/afterpack-dev/afterpack/issues).
