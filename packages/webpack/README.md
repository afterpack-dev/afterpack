# @afterpack/webpack

AfterPack webpack plugin — obfuscates your build output **inside webpack's own asset pipeline**,
before a byte of it reaches disk, and writes the Protection Map beside your project rather than
inside the build.

```js
// webpack.config.mjs
import { AfterpackWebpackPlugin } from "@afterpack/webpack";

export default {
  // ...
  plugins: [new AfterpackWebpackPlugin()],
};
```

The plugin taps `compilation.hooks.processAssets` at `PROCESS_ASSETS_STAGE_REPORT` — the last stage
before webpack writes. It reads each asset's bytes out of the compilation, obfuscates via
`@afterpack/core`, and hands the result back through `compilation.updateAsset`, so **webpack never
writes the cleartext bundle**: a failed obfuscation aborts the build with an untouched output
directory. It is **fail-closed**: an `error`/`critical` diagnostic, or empty output, fails the build
rather than shipping unobfuscated code.

Only the `.js`/`.mjs`/`.cjs` assets a **chunk of this compilation claims** are rewritten (HMR update
chunks excluded). A compiler also carries assets it did not build — a manifest another plugin
emitted, a copied file — and rewriting those is over-reach, not protection.

`experimental.sri` and any other integrity plugin stay correct: they tap `afterProcessAssets`, which
runs after this whole pipeline, so the hashes are computed over the obfuscated bytes.

## What it writes

- `foo.js.map` — the composed source map replaces webpack's own map asset, when `sourceMap` is on.
  When policy ships no map (the production default), webpack's map asset is **deleted**: it describes
  the pre-obfuscation bytes and carries `sourcesContent`, so shipping it beside obfuscated code is a
  complete deobfuscation.
- `.afterpack/protectionMap.html` — ONE combined, self-contained Protection Map for the whole build,
  written to a gitignored directory rather than into webpack's output path itself.

There is no `foo.backup.<hash>.js` here. The obfuscated bytes are handed back to webpack rather than
written beside an emitted file, so there is nothing for a backup to sit beside — and a backup inside
a deployable tree is the original source verbatim. `build.backup: true` says so instead of silently
doing nothing.

`paths.include` is refused: it re-admits what an on-disk walk skips, and this plugin does no walk.

It also appends the artifact guard globs (`.afterpack/`, `*.protectionMap.html`, `protectionMap.html`,
`*.backup.*`, `*.map`) to your project `.gitignore`, and warns if an artifact lands under a served path.

## Options

Every option below defaults independently; a production auto-flip (detected from `NODE_ENV=production`,
`CI=true`, or an explicit `production: true`) adjusts some of them. Explicit options always win.

| Option | Type | Default | Prod flip |
| --- | --- | --- | --- |
| `seed` | `number \| string` | fresh random per build | — |
| `build.autorun` | `boolean` | `true` (or `AFTERPACK_build_autorun=false`) | — |
| `protectionMap` | `boolean` | ON iff a bundler sourcemap is discovered | governed by that, not prod; warns loudly if left on (always lands in gitignored `.afterpack/`) |
| `sourceMap` | `boolean` | auto (on iff an input map exists) | OFF |
| `sourceMap.emitUrl` | `boolean` | ON | **OFF in prod** (a public obfuscator map = full deobfuscation) |
| `build.backup` | `boolean` | OFF | OFF (explicit `true` always wins) |
| `production` | `boolean` | inferred from env | forces the prod posture |
| `directives` | `boolean` | ON | — |

Directives are captured pre-minify via webpack's `NormalModule` `beforeLoaders` hook, which sees every
module's original resource before any loader or minifier touches it. The captured text is then
backward-colored through each emitted chunk's own source map, so `/* @afterpack ... */` comments
survive bundling. That needs a `devtool` that emits source maps (e.g. `"source-map"`); without one the
pass skips them and says so rather than over-applying.

```js
// Turn everything sensitive off:
new AfterpackWebpackPlugin({ protectionMap: false, sourceMap: false, directives: false });
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
other option keeps the name it has above.

The whole configuration is validated when the plugin is constructed: an unknown key, a kebab-cased
key or a malformed value fails the build naming the canonical spelling, instead of being silently
discarded.
