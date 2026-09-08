# @afterpack/esbuild

AfterPack esbuild plugin — obfuscates your build output after esbuild writes it, and drops the
debugging + insight artifacts (a source map, a Protection Map, and an original-source backup) next
to each file. esbuild has no in-pipeline seam for this, so there is a **cleartext window** — see
below.

```ts
// build.ts
import { build } from "esbuild";
import { afterpackEsbuild } from "@afterpack/esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outdir: "dist",
  bundle: true,
  plugins: [afterpackEsbuild()],
});
```

The plugin runs in `onEnd`, after esbuild finishes and (with the default `write !== false`) has
written its output to disk. It handles both the `outdir` (many files) and `outfile` (single file)
shapes, and skips a `write: false` build (output stays in memory only) or one that already errored.
It is **fail-closed**: if the engine reports an `error`/`critical` diagnostic (or empty output), the
hook throws and the build fails rather than shipping unobfuscated code.

### The cleartext window

esbuild offers no post-bundle asset-rewrite hook while `write: true`, so this plugin obfuscates
**after** esbuild has written. Between esbuild's write and this pass finishing, your unobfuscated
bundle exists on disk — measured at tens of milliseconds on a real build. Anything that can read your
output directory during the build (a watcher, a CI artifact step running concurrently, another
process on a shared runner) can read it in the clear. A failed obfuscation also leaves the cleartext
output in place, because it is already written; the build fails, so nothing ships, but the files are
there until the next build overwrites them.

We will not close this by flipping your `write` setting behind your back. The bundlers whose APIs
allow it obfuscate in-pipeline instead and have no such window: `@afterpack/vite`, `@afterpack/rollup`,
`@afterpack/webpack` and `@afterpack/parcel-optimizer`. `@afterpack/angular` has the same window as
this package, for the same reason (a sealed builder). `@afterpack/next` is in between: it obfuscates
from inside `next build`, so a failure aborts the build and no lifecycle script can be skipped — but
Next writes the chunks before the hook runs, so a window of roughly a second exists inside the build
process. If the window matters for your threat model, build through one of the first four, or run
the build in a directory nothing else can read.

## What it writes

- `foo.js.map` — the composed source map, when `sourceMap` is on.
- `foo.backup.<hash>.js` — the original (pre-obfuscation) file, when `backup` is enabled.
- `.afterpack/protectionMap.html` — ONE combined, self-contained Protection Map for the whole build,
  written to a gitignored directory rather than into `outdir` itself.
- `<outdir>/.afterpack-protection.json` — the protection receipt, a sha256 per obfuscated file.
  `npx afterpack verify <outdir>` re-checks it in the deploy step.

It also appends the artifact guard globs (`.afterpack/`, `*.protectionMap.html`, `protectionMap.html`,
`*.backup.*`, `*.map`) to your project `.gitignore`, and warns if an artifact lands under a served path.

## Options

Every option below defaults independently; a production auto-flip (detected from `NODE_ENV=production`,
`CI=true`, or an explicit `production: true`) adjusts some of them. Explicit options always win.

| Option | Type | Default | Prod flip |
| --- | --- | --- | --- |
| `seed` | `number \| string` | fresh random per build | — |
| `build.autorun` | `boolean` | `true` (or `AFTERPACK_build_autorun=false`) | — |
| `protectionMap` | `boolean` | ON iff esbuild's own `sourcemap` option is set | governed by that, not prod; warns loudly if left on (always lands in gitignored `.afterpack/`) |
| `sourceMap` | `boolean` | auto (on iff an input map exists) | OFF |
| `sourceMap.emitUrl` | `boolean` | ON | **OFF in prod** (a public obfuscator map = full deobfuscation) |
| `build.backup` | `boolean` | OFF | OFF (explicit `true` always wins) |
| `production` | `boolean` | inferred from env | forces the prod posture |
| `directives` | `boolean` | `true` (the one shared default) | — |

esbuild's `onLoad` hook runs before the bundle is assembled, and `onEnd` only sees the finished,
already-minified output — there is no pre-minify point to capture `/* @afterpack ... */` comments the
way the other plugins do. They are recovered POST-minify instead, from each emitted chunk's own
source-map `sourcesContent`, so this path needs esbuild's own `sourcemap: true`. Without a usable map
nothing is applied; the pass says so if you asked for directives explicitly, and stays quiet if you
were simply on the default.

```ts
// Per-region directives need esbuild's own source maps:
await build({ /* ... */, sourcemap: true, plugins: [afterpackEsbuild()] });
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
