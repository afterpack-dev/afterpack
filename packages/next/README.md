# @afterpack/next

AfterPack Next.js integration — obfuscates the client JavaScript **inside `next build`**, on
Turbopack or webpack, App Router or Pages Router or static export, and drops the debugging + insight
artifacts (a source map, a Protection Map) next to each file.

```ts
// next.config.ts
import type { NextConfig } from "next";
import { withAfterpack } from "@afterpack/next";

const nextConfig: NextConfig = {
  /* your config */
};

export default withAfterpack(nextConfig);
```

Next's other config form works the same way — `withAfterpack(async (phase, ctx) => ({ … }))`
returns a wrapped function, not an object.

That is the whole setup. There is **no postbuild script and no bin**: `withAfterpack` returns a
config carrying Next's own [`compiler.runAfterProductionCompile`][hook] hook, which Next calls once,
outside the bundler branch, right after compilation and before type-checking, prerendering and
static export. So `next build` on its own produces obfuscated output — a CI job that invokes
`next build` directly, or an install run with `--ignore-scripts`, cannot ship the cleartext bundle.

[hook]: https://nextjs.org/docs/architecture/nextjs-compiler#runafterproductioncompile

If the hook throws, the build fails with exit 1. That is the intended behaviour: there is no path
where `next build` succeeds and your chunks are still readable.

## What it obfuscates

`<distDir>/static/chunks` — the client JS, whatever bundler wrote it. `.next/server` is deliberately
left alone: the SSR renderer, React Server Components and API/edge routes never reach a browser, so
obfuscating them is pure build time, output size and Worker cold-start cost for no client-exposure
benefit. With `output: "export"` the export copies `.next/static` into `out/_next/static` **after**
the hook, so the shipped `out/` tree carries the obfuscated chunks.

It also deletes every `.js.map` from the client tree and strips the matching `//# sourceMappingURL=`
comment — a served map carries full `sourcesContent`, which is total deobfuscation.

## Proving a deploy is protected

Every protected build writes `.next/.afterpack-protection.json`: the engine version, the seed, the
bundler, the build id, and a sha256 per obfuscated file. Check it in your deploy step:

```sh
npx afterpack verify .       # or: npx afterpack verify .next
```

Non-zero exit when the receipt is missing, is from a different build (the tree was rebuilt without
the wrapper), or any recorded file no longer hashes to what it was obfuscated to.

## Composing with your own build hook

`runAfterProductionCompile` is a single-slot config key, so a hook you already set is **composed,
not replaced**. Yours runs **first**, AfterPack's second: yours sees exactly the bytes it would see
with AfterPack uninstalled, and AfterPack still sees the final ones, so nothing a hook writes can
escape obfuscation. A hook that uploads source maps for error reporting is the case to think about —
it will upload maps of the pre-obfuscation code, which no longer describes what you shipped.

## Known incompatibility

`experimental.sri` is **refused**, with an error naming the conflict. Next computes each asset's
integrity hash while writing it, before any build hook can run, and bakes it into every
`<script integrity=…>`; rewriting the chunk afterwards makes the browser block it. Remove
`experimental.sri`, or remove `withAfterpack`.

## What it writes

- `foo.js.map` — the composed source map (kept even in prod; see policy below).
- `foo.backup.<hash>.js` — the pre-obfuscation original. **Only with `build.backup: true`**.
- `protectionMap.html` — ONE combined, self-contained Protection Map, in the gitignored `.afterpack/`.
- `.next/.afterpack-protection.json` — the protection receipt (above).

It also appends the artifact guard globs (`.afterpack/`, `*.protectionMap.html`, `protectionMap.html`,
`*.backup.*`, `*.map`) to your project `.gitignore`, and warns if an artifact lands under a served path.

## Options

Passed to `withAfterpack(config, options)` and closed over by the hook — no file, no second
resolution, nothing to drop them. They rank above `AFTERPACK_*` and `afterpack.json`, and every
registry key works in all three places. All options are opt-out (**ON by default**) with a
**production auto-flip**: because `next build` sets `NODE_ENV=production`, the production-safe
posture applies out of the box — opt back in explicitly to see the full artifacts locally. Explicit
options always win.

| Option | Type | Default | Prod flip |
| --- | --- | --- | --- |
| `seed` | `number \| string` | a fresh random seed per build | — |
| `build.autorun` | `boolean` | `true` (or `AFTERPACK_build_autorun=false`) | — |
| `protectionMap` | `boolean` | ON iff a bundler sourcemap is discovered | governed by that, not prod; warns loudly if left on in prod (it always lands in gitignored `.afterpack/`) |
| `sourceMap` | `boolean` | auto (on iff an input map exists) | **OFF in prod** (a map leads straight back to your source) |
| `sourceMap.emitUrl` | `boolean` | ON | **OFF in prod** (a public obfuscator map = full deobfuscation) |
| `build.backup` | `boolean` | **OFF** | OFF — the pass obfuscates in place, so a `.backup.<hash>.js` would ship your original source into the deployable tree. Explicit `build.backup: true` always wins. |
| `production` | `boolean` | inferred from env | forces the prod posture |
| `directives` | `boolean` | `true` (the one shared default) — Next has no pre-minify hook, so they are recovered post-minify from each chunk's own source map, which needs `productionBrowserSourceMaps: true` | — |

```ts
// Generate the Protection Map for a build (writes to gitignored .afterpack/):
withAfterpack(nextConfig, { protectionMap: true });
```

## Feedback

Questions and proposals: https://github.com/afterpack-dev/afterpack/discussions · Bugs: https://github.com/afterpack-dev/afterpack/issues
