# @afterpack/angular

AfterPack for **Angular** (v17+) — obfuscates your `ng build` output.

Modern Angular builds with the default `@angular-devkit/build-angular:application` builder, which is
esbuild-based but **sealed**: it exposes no consumer plugin hook, so — unlike the Vite/webpack/Rollup
plugins — AfterPack cannot ride an in-build hook here. The robust, honest integration is a **postbuild
pass** over the emitted browser bundle. This package is a thin convenience over that; it contains **zero
obfuscation logic** and simply runs the same shared pass the plugins use.

### The cleartext window

Because the pass runs after `ng build` has finished writing, your unobfuscated bundle exists on disk
until it completes. Anything that can read `dist/` during the build can read it in the clear, and a
failed obfuscation leaves the cleartext output in place (the build fails, so nothing ships, but the
files are there until the next build overwrites them). This is a property of the sealed builder, not
a choice: `@afterpack/vite`, `@afterpack/rollup`, `@afterpack/webpack` and
`@afterpack/parcel-optimizer` obfuscate inside the bundler's own pipeline and have no such window.
`@afterpack/next` narrows but does not close it — it runs from inside `next build`, so it cannot be
skipped and a failure aborts the build, but Next writes the chunks before the hook runs.
`@afterpack/esbuild` shares this window for the same reason.

## Canonical path: the `afterpack` CLI

The simplest, dependency-light path needs nothing from this package — just the universal
[`afterpack`](../cli) CLI as a postbuild step:

```jsonc
// package.json
{
  "scripts": {
    "build": "ng build && afterpack dist/*/browser --seed git"
  }
}
```

Angular's application builder writes the client bundle to `dist/<app>/browser`; point the CLI at it and
every emitted `.js` chunk is obfuscated in place, with a source map and a Protection Map dropped
alongside. This is exactly what the framework-integration fixture does.

## Convenience: the programmatic helper

If you prefer a Node postbuild script (e.g. to avoid hard-coding the app name in a shell glob), this
package auto-locates the browser output and runs the pass:

```ts
// scripts/obfuscate.mjs — run after `ng build`
import { afterpackAngular } from "@afterpack/angular";

await afterpackAngular({ seed: "git" }); // finds dist/*/browser under cwd
```

`afterpackAngular(options)` locates `dist/*/browser` (override with `distRoot` or `browserDir`),
collects the emitted JS, and obfuscates it in place. Fail-closed: throws on any engine failure.

Options (`seed`, `preset`, `complexity`, `protectionMap`, `regions`, `backup`, `sourceMap`, …) mirror every other
AfterPack front door, so a config is portable. See [`@afterpack/integration-utils`](../integration-utils)
for the full reference.

**`directives` is refused here, in every layer** (options object, `AFTERPACK_directives`,
`afterpack.json`) — the application builder is sealed, so this postbuild pass only ever sees
already-minified output and has no hook to capture `/* @afterpack ... */` comments from. Setting it
fails the build with that reason rather than being quietly ignored. Build through a bundler AfterPack
can hook ([`@afterpack/vite`](../vite), [`@afterpack/webpack`](../webpack),
[`@afterpack/esbuild`](../esbuild)) if you need them.

## Legacy Angular (webpack)

Angular projects still on the older webpack-based builder can obfuscate in-build with
[`@afterpack/webpack`](../webpack) via a custom builder, but the CLI postbuild above works uniformly
across both builders and is the recommended path.

## Configuration

Every option above can also be set in `afterpack.json` — the one config file every AfterPack
integration reads, at the nearest ancestor of your working directory — or in an `AFTERPACK_<key>`
environment variable. Most specific wins: the options object here, then the environment, then the
file.

```json
{
  "preset": "hard",
  "seed": "git"
}
```

In the file and the environment each option carries its canonical name: `protectionMap` is
`protectionMap.enabled`, `sourceMap` is `sourceMap.enabled`, `complexity` is already the registry key, and every
other option keeps the name it has above. `cwd`, `distRoot` and `browserDir` locate the build rather than configure it, so they belong in the options object only.

The whole configuration is validated when the plugin is constructed: an unknown key, a kebab-cased
key or a malformed value fails the build naming the canonical spelling, instead of being silently
discarded.
