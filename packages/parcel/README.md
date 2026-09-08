# @afterpack/parcel-optimizer

AfterPack Parcel 2 plugin — obfuscates each packaged bundle **in memory**, during Parcel's own
optimize phase, so the bundle never touches disk in cleartext.

```jsonc
// .parcelrc
{
  "extends": "@parcel/config-default",
  "optimizers": {
    "*.{js,mjs,cjs}": ["...", "@afterpack/parcel-optimizer"]
  }
}
```

The `"..."` spread matters: it keeps Parcel's default optimizers (`@parcel/optimizer-swc`) and puts
AfterPack **last**, which is where it belongs — AfterPack is the final protective seal, not an input
to a minifier. Putting it first would feed 80×-inflated output back through swc `compress` +
`mangle --toplevel` for nothing.

> **The package is `@afterpack/parcel-optimizer`, not `@afterpack/parcel`.** Parcel validates plugin
> names against the plugin type and hard-asserts that a scoped plugin is named
> `@scope/parcel-<type>[-<name>]`, so `@afterpack/parcel` is rejected by `.parcelrc` itself.

Unlike every other AfterPack bundler plugin, this one never reads or writes your output tree. Parcel
hands `optimize()` the packaged bundle's contents plus a live `@parcel/source-map`, AfterPack returns
the obfuscated replacement, and Parcel writes it. It is **fail-closed**: an `error`/`critical`
diagnostic, empty output, or a destroyed Parcel content-hash placeholder (see below) throws and fails
the build rather than shipping unobfuscated or broken code.

## Configuration

`.parcelrc` entries are bare package names with no inline options, so options come from
`afterpack.json` — the one config file every AfterPack integration reads, at the nearest ancestor of
your project root — or from an `AFTERPACK_<key>` environment variable, which outranks the file.
`.afterpackrc.json`, `.afterpackrc`, `afterpack.config.json` and the `package.json#afterpack` key are
no longer read; rename yours.

```json
{
  "seed": "git",
  "preset": "medium"
}
```

Every key is validated against the shared schema: an unknown key fails the build with the canonical
spelling instead of being discarded.

Two keys behave differently under an Optimizer. **`seed`** — Parcel packages bundles across worker
PROCESSES and only bundles sharing a process share a drawn seed, so set `seed` (or `AFTERPACK_SEED`)
to pin one across the whole build. **`directives`** — an Optimizer sees finished, already-minified
bytes whose comments are gone, so directives are recovered POST-minify from the bundle's own source
map `sourcesContent`; non-entry modules work, the ENTRY module typically does not (Parcel's map gives
its interior zero coverage), and the pass WARNS loudly rather than silently applying nothing.

## What it writes

Only project-root artifacts — nothing lands beside your bundles:

- `.afterpack/<bundle>.<id>.protectionMap.html` — a Protection Map **per bundle**. Parcel invokes an
  optimizer once per bundle with no build-end hook available, so there is no single combined map;
  merging them would need a companion reporter package.

It also appends the artifact guard globs (`.afterpack/`, `*.protectionMap.html`, `protectionMap.html`,
`*.backup.*`, `*.map`) to your project `.gitignore`.

There is **no `foo.backup.<hash>.js`** on this plugin: there is no emitted file for a backup to sit
beside. Setting `build.backup: true` warns rather than silently doing nothing.

The source map is returned to Parcel rather than written directly, so Parcel names and emits it with
its own content hash. Per AfterPack's standard policy, maps are **off in production** — a map leads
straight back to the source this pass exists to protect. Set `"sourceMap": { "enabled": true }` to override.

## Options

Every option below defaults independently; a production auto-flip (Parcel's `--mode production`,
which `parcel build` sets, or `NODE_ENV=production` / `CI=true`) adjusts some of them. Explicit
options always win.

| Option | Type | Default | Prod flip |
| --- | --- | --- | --- |
| `seed` | `number \| string` | fresh random per build | — |
| `build.autorun` | `boolean` | `true` (or `AFTERPACK_build_autorun=false`) | — |
| `preset` | `"minify" \| "light" \| "medium" \| "hard" \| "extreme"` | `light` | — |
| `complexity` | `number` | from `preset` | — |
| `protectionMap` | `boolean` | ON iff the bundle carries a source map | governed by that, not prod; warns loudly if left on (always lands in gitignored `.afterpack/`) |
| `sourceMap` | `boolean` | auto (on iff an input map exists) | OFF |
| `sourceMap.emitUrl` | `boolean` | ON | **OFF in prod** (a public obfuscator map = full deobfuscation) |
| `build.backup` | `boolean` | OFF | not available here — warns if set |
| `production` | `boolean` | inferred from Parcel's mode | forces the prod posture |
| `directives` | `boolean` | `true` (the one shared default) | — |

`directives` carries the one shared default (**on**), but an optimizer sees finished,
already-minified bytes whose `/* @afterpack ... */` comments are long gone, so they are recovered
post-minify from the bundle's own source-map `sourcesContent` — which needs source maps enabled on
the Parcel target. With no usable map the pass says so if you asked for directives explicitly, and
stays quiet if you were simply on the default. A true pre-minify capture channel would be a Parcel
*Transformer*, which the naming rule above forces into a separate package.

**Directives in your ENTRY module are not recoverable.** Parcel's map chains the final bundle back
through a pre-optimize `<anon>` scope-hoist stage that never carries a live mapping segment, and in
practice the entry module's own interior often gets none either — so a directive written there has
nothing to color onto. The pass fails loud, not silent: it warns by name that the module's interior
could not be resolved in the map, and does **not** apply the directive, rather than blaming
tree-shaking or (worse) reporting success. **Directives in every other (non-entry) module work** —
they color onto the bundle normally once source maps are on. If you need an entry-module directive
today, move the guarded code into an imported module.

## Parcel-specific behavior worth knowing

**Content-hash placeholders — the one thing that can fail your build.** With content hashing on (the
default for `parcel build`), Parcel emits `HASH_REF_<16 hex>` tokens into bundles and substitutes the
real hash by a raw byte scan *after* every optimizer. When Parcel targets browsers without native ESM
it puts those tokens in **string literals** (the lazy-chunk URL map), and AfterPack's string floor —
on at every positive complexity target — encodes them. The substitution then silently finds nothing
and every code-split chunk 404s in production. This plugin detects that and fails the build:

```
AfterPack obfuscated 1 Parcel content-hash placeholder(s) in app.[hash].js (HASH_REF_...).
  hint: Run `parcel build --no-content-hash` (chunk URLs stop being content-addressed).
  hint: Or set "complexity": { "target": 0 } in afterpack.json to ship minify-only.
```

Parcel's **default ESM output is unaffected** — it carries lazy-chunk URLs in an HTML importmap,
which AfterPack never touches.

**One pass per bundle.** Parcel runs optimizers per bundle, in worker processes. So the engine batch
is always a single file, and bundles packaged in different worker processes cannot share state. The
plugin registers each bundle as a *leg* of one build, so bundles packaged in the same process share
one seed; to pin one seed across every worker, set `seed` explicitly or export `AFTERPACK_SEED`.

**Parcel caches optimizer output.** A rebuild with a warm `.parcel-cache` and unchanged input does
not re-run AfterPack (and does not rotate an unpinned seed). Clear `.parcel-cache` for a genuinely
fresh obfuscation pass; CI builds from a cold cache anyway.

**Two harmless warnings.** Parcel prints `ES module dependencies are experimental` (every AfterPack
package is ESM; Parcel loads it with `await import()`) and reports that the plugin `contains
non-statically analyzable dependencies` (the native engine's runtime binary resolution). Neither
affects the build.

```js
// Turn everything sensitive off:
{ "protectionMap": false, "sourceMap": false }
```
