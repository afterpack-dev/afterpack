# @afterpack/rollup

AfterPack Rollup plugin — obfuscates your build output **inside Rollup's own pipeline**, before a
byte of it reaches disk, and writes the Protection Map beside your project rather than inside the
build.

```js
// rollup.config.js
import { afterpackRollup } from "@afterpack/rollup";

export default {
  input: "src/index.ts",
  output: { dir: "dist", format: "esm" },
  plugins: [afterpackRollup()],
};
```

The plugin runs in `generateBundle` (`order: "post"`), with the finished bundle in memory and BEFORE
Rollup writes any of it. For each JS entry in the bundle it takes Rollup's own live source map,
obfuscates via `@afterpack/core`, and hands the chunk back — so **Rollup never writes the cleartext
bundle**, and a refusal leaves the output directory untouched. It is **fail-closed**: if the engine
reports an `error`/`critical` diagnostic (or empty output), the hook throws and the build fails
rather than shipping unobfuscated code.

`order: "post"` puts AfterPack last among `generateBundle` hooks — it is the final seal, and anything
rewriting a chunk after it would be rewriting obfuscated code.

## What it writes

- `foo.js.map` — the composed source map replaces Rollup's own map entry, when `sourceMap` is on.
  When policy ships no map (the production default) that entry is **dropped**: it describes the
  pre-obfuscation bytes and carries `sourcesContent`, so shipping it beside obfuscated code is a
  complete deobfuscation.
- `.afterpack/protectionMap.html` — ONE combined, self-contained Protection Map for the whole build,
  written to a gitignored directory rather than into the output dir itself.

There is no `foo.backup.<hash>.js` here: the obfuscated bytes go back into the bundle rather than
beside an emitted file, so there is nothing for a backup to sit next to. `build.backup: true` says so
instead of silently doing nothing. `paths.include` is refused — it re-admits what an on-disk walk
skips, and this plugin does no walk.

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

For a single un-bundled output file, `/* @afterpack ... */` comments are read straight from the
emitted source. When Rollup bundles multiple modules together, a `transform` hook captures each
module's original text before any minifier strips its comments, and `generateBundle` backward-colors
those spans through the emitted chunk's own source map, so directives survive bundling. That needs
`output.sourcemap: true`; without one the pass skips them and says so rather than over-applying.

```js
// Turn everything sensitive off:
afterpackRollup({ protectionMap: false, sourceMap: false, directives: false });
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
