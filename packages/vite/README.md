# @afterpack/vite

AfterPack Vite/Rollup plugin — obfuscates your build output **inside the bundler's own pipeline**,
before a byte of it reaches disk, and writes the Protection Map beside your project rather than
inside the build.

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { afterpackVite } from "@afterpack/vite";

export default defineConfig({
  plugins: [afterpackVite()],
});
```

The plugin runs in `generateBundle` (`order: "post"`), with the finished bundle in memory and BEFORE
Vite writes any of it. For each JS entry in the bundle it takes the bundler's own live source map,
obfuscates via `@afterpack/core`, and hands the chunk back — so **the cleartext bundle never reaches
disk**, and a refusal leaves the output directory untouched. It is **fail-closed**: if the engine
reports an `error`/`critical` diagnostic (or empty output), the hook throws and the build fails
rather than shipping unobfuscated code.

What it obfuscates is exactly what the bundler **built**: every chunk in the output bundle. Files
Vite copies verbatim into the output directory (`publicDir`) are not built, are not in the bundle,
and are not touched — put anything that needs protecting through the bundler.

## What it writes

- `foo.js.map` — the composed source map replaces the bundler's own map entry, when `sourceMap` is
  on. When policy ships no map (the production default) that entry is **dropped**: it describes the
  pre-obfuscation bytes and carries `sourcesContent`, so shipping it beside obfuscated code is a
  complete deobfuscation.
- `protectionMap.html` — ONE combined, self-contained Protection Map for the whole build dir.

There is no `foo.backup.<hash>.js` here: the obfuscated bytes go back into the bundle rather than
beside an emitted file, so there is nothing for a backup to sit next to. `build.backup: true` says so
instead of silently doing nothing. `paths.include` is refused — it re-admits what an on-disk walk
skips, and this plugin does no walk.

It also appends the artifact guard globs (`.afterpack/`, `*.protectionMap.html`, `protectionMap.html`,
`*.backup.*`, `*.map`) to your project `.gitignore`, and warns if an artifact lands under a served path.

## Options

All options are opt-out (**ON by default**), with a **production auto-flip** (detected from
`NODE_ENV=production`, `CI=true`, or a framework prod hook — `vite build` sets `NODE_ENV=production`).
Explicit options always win.

| Option | Type | Default | Prod flip |
| --- | --- | --- | --- |
| `seed` | `number \| string` | a fresh random seed per build | — |
| `build.autorun` | `boolean` | `true` (or `AFTERPACK_build_autorun=false`) | — |
| `protectionMap` | `boolean` | ON iff a bundler sourcemap is discovered | governed by that, not prod; warns loudly if left on in prod (it always lands in gitignored `.afterpack/`) |
| `sourceMap` | `boolean` | auto (on iff an input map exists) | **OFF in prod** (a map leads straight back to your source) |
| `sourceMap.emitUrl` | `boolean` | ON | **OFF in prod** (a public obfuscator map = full deobfuscation) |
| `production` | `boolean` | inferred from env | forces the prod posture |
| `directives` | `boolean` | ON — captured pre-minify, so your `/* @afterpack */` comments survive the bundler | — |
| `leg` | `string` | — | see "Multi-config builds" |
| `projectRoot` | `string` | Vite's `root` | see "Multi-config builds" |

```ts
// See the real Protection Map even on a production build (writes to gitignored .afterpack/):
afterpackVite({ protectionMap: true });
// Advertise the source map in prod too (opt-in):
afterpackVite({ sourceMap: { emitUrl: true } });
// Turn everything sensitive off:
afterpackVite({ protectionMap: false, sourceMap: false });
```

## Multi-config builds (Electron, SSR pairs)

Some apps run Vite more than once for a single logical build — Electron's main/preload/renderer, an
SSR client/server pair. Two options make one instance of this plugin a named **leg** of that build.
Each leg only ever sees its OWN bundle, so two builds sharing one `outDir` (Electron Forge points
main and preload at `.vite/build`) no longer step on each other:

- **`leg`** — `"main"`, `"renderer"`, `"client"`, `"server"`… It suffixes the diagnostic label, keys
  the shared build seed (every leg of one build obfuscates with ONE seed, drawn once), and nests this
  leg's Protection Map under `.afterpack/<leg>/` so the legs stop overwriting each other's map.
- **`projectRoot`** — the APP root, when Vite's own `root` is a sub-directory of it (electron-vite
  roots the renderer build at `src/renderer/`). It is where `.gitignore` and `.afterpack/` land, and
  which build a leg joins for the shared seed. Legs with different roots are different builds.

Across separate PROCESSES there is no session to share, so set the seed in the environment instead —
`AFTERPACK_SEED` takes the same values as `seed` (an integer, `git`, or any other string):

```sh
AFTERPACK_SEED=git npm run build   # every leg, and `npx afterpack`, pick it up
```

For Electron specifically, use [`@afterpack/electron`](https://www.npmjs.com/package/@afterpack/electron),
which sets both per leg and adds the Electron-specific fail-closed guards.

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
