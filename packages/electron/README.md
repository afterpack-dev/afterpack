# @afterpack/electron

AfterPack Electron integration — obfuscates the **main**, **preload** and **renderer** bundles of one
app in a single call, with **one shared build seed**, and drops the debugging + insight artifacts (a
source map, a Protection Map) outside the tree your packager copies into `app.asar`.

```js
// electron.vite.config.ts
import { withAfterpack } from "@afterpack/electron";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default withAfterpack(
  defineConfig({
    main: { plugins: [externalizeDepsPlugin()] },
    preload: { plugins: [externalizeDepsPlugin()] },
    renderer: {},
  }),
);
```

`withAfterpack` wires `@afterpack/vite` into every leg the config declares (never one it doesn't) and
prints `wired into legs: main, preload, renderer`. Each leg obfuscates its own bundle before Vite
writes it, and is **fail-closed**: an `error`/`critical` diagnostic, empty output, or V8 bytecode in
the output fails the build rather than shipping unobfuscated code.

## Why a package, and not three copies of the Vite plugin

An Electron app is two or three separately-bundled programs. Wired by hand, each leg is its own Vite
build and draws its **own random seed**, so the halves of one application get structurally unrelated
obfuscation.

This package fixes that: every leg joins one **build-seed session** (keyed by the project root, in
`@afterpack/integration-utils`). Legs sharing an output directory — under Electron Forge, main and
preload both write to `.vite/build` — no longer collide either: AfterPack obfuscates each leg's own
bundle in `generateBundle`, so a leg cannot see, let alone rewrite, another's output. The summary
line reports which seed each leg used:

```
[afterpack-vite:main]     obfuscated 1 file(s) … · seed 6622856958135804 (fresh)
[afterpack-vite:preload]  obfuscated 1 file(s) … · seed 6622856958135804 (session)
[afterpack-vite:renderer] obfuscated 1 file(s) … · seed 6622856958135804 (session)
```

A fresh seed is still drawn **per build** — that per-build polymorphism is the whole defense — it is
just drawn once for the whole app instead of once per leg.

## One leg at a time

Toolchains that load each leg's Vite config separately (Electron Forge) get the same result from
three calls. `leg` is **required**: under Forge, main and preload are near-identical configs writing
to one directory, so an inferred leg would silently collapse the two into one.

```js
// vite.main.config.ts   (and vite.preload.config.ts / vite.renderer.config.ts)
import { afterpackElectron } from "@afterpack/electron";

export default { plugins: [afterpackElectron({ leg: "main" })] };
```

## When the legs are separate processes

If your build script runs each leg as its own command (`vite build -c vite.main.ts && vite build -c
vite.renderer.ts && electron-builder`), there is no shared process to hold the session. Set the seed
once in the environment and every leg — and `npx afterpack` — picks it up:

```jsonc
// package.json
"build": "AFTERPACK_SEED=git vite build -c vite.main.ts && vite build -c vite.renderer.ts"
```

`AFTERPACK_SEED` takes the same values as `seed`: an integer, `git` (derived from `HEAD`), or any
other string. AfterPack warns at exit when only one leg was obfuscated in a process and no seed was
pinned, which is exactly this situation.

## Support matrix

| Toolchain | Wiring | One seed? |
| --- | --- | --- |
| **electron-vite** | `withAfterpack(defineConfig({…}))` — one call | yes, automatic (one process) |
| **electron-forge + plugin-vite** | `afterpackElectron({ leg })` in each of the three configs | yes, automatic (one process) |
| **electron-forge + plugin-webpack** | `@afterpack/webpack` in each config | yes, automatic (one process) |
| **vite-plugin-electron** | `afterpackElectron({ leg: "renderer" })`, placed **last** | yes — place it last so AfterPack's `generateBundle` seals the finished bundle |
| **electron-builder** | it packages, it does not bundle — wire the bundler above it | n/a |
| **hand-rolled scripts (separate processes)** | plugin per leg, or `npx afterpack <dir>` for an un-bundled `tsc` main | **no** — set `AFTERPACK_SEED` (see above) |

## What it refuses

| Situation | What happens |
| --- | --- |
| `bytecodePlugin` (electron-vite) on the same leg | **build fails.** It replaces every chunk with a 3-line loader and ships the app as `.jsc` bytecode, so AfterPack would obfuscate the loader and report success while the application went untouched. They run on opposite sides of the write and cannot compose. |
| `.jsc`/`.cjsc` found in the output after the pass | **build fails**, same reason. |
| `build.backup: true` | **throws at construction.** The `.backup.<hash>.js` is the complete original source, sitting inside the tree the packager copies into `app.asar`. |
| `sourceMap: true` / `sourceMap: { emitUrl: true }` | Loud warning. A `.map` with `sourcesContent` inside `app.asar` is full deobfuscation; keep it to local debug builds. |
| A packager config is present | One-time notice with the exact exclusion snippet — electron-builder matches with `dot: true` and does **not** exclude `.afterpack` by default. |

Add the exclusions to your packager, once:

```jsonc
// electron-builder
"files": ["**/*", "!.afterpack/**", "!**/*.backup.*", "!**/*.map"]
// electron-forge
packagerConfig: { ignore: [/^\/\.afterpack/, /\.backup\./, /\.map$/] }
```

## Options

Every `@afterpack/vite` option is accepted and forwarded verbatim, except `leg`, which
this package sets per leg. The ones that matter most here:

| Option | Type | Default |
| --- | --- | --- |
| `seed` | `number \| string` | fresh random per build, shared by every leg (`"git"` derives it from `HEAD`) |
| `preset` | `"minify" \| "light" \| "medium" \| "hard" \| "extreme"` | `light` |
| `complexity` | `number` | the preset's target |
| `protectionMap` | `boolean` | ON iff a bundler sourcemap is discovered; each leg writes its own to `.afterpack/<leg>/protectionMap.html` |
| `build.backup` | `boolean` | OFF — and `true` is refused, see above |
| `projectRoot` | `string` | `process.cwd()` — the app root. electron-vite roots the renderer build at `src/renderer/`, so this is what keeps all three legs in ONE seed session; override it if your build runs from somewhere else |
| `build.autorun` | `boolean` | `true` (or `AFTERPACK_build_autorun=false`) |

```js
// Heavier protection, reproducible per commit:
withAfterpack(config, { preset: "hard", seed: "git" });
```

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
other option keeps the name it has above. `leg` and `projectRoot` name this build rather than configure it, so they belong in the options object only.

The whole configuration is validated when the plugin is constructed: an unknown key, a kebab-cased
key or a malformed value fails the build naming the canonical spelling, instead of being silently
discarded.

## Feedback

Questions and proposals: https://github.com/afterpack-dev/afterpack/discussions · Bugs: https://github.com/afterpack-dev/afterpack/issues
