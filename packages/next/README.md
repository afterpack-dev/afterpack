# @afterpack/next

Obfuscate a Next.js build with one config wrapper. `@afterpack/next` protects the client JavaScript
that `next build` produces, using the [AfterPack](https://www.afterpack.dev) JavaScript obfuscator.
It needs Next.js 15.4 or later and works with Turbopack or webpack, the App Router or the Pages
Router, and static export.

## Install

```sh
npm install --save-dev @afterpack/next
```

## Usage

```ts
// next.config.ts
import type { NextConfig } from "next";
import { withAfterpack } from "@afterpack/next";

const nextConfig: NextConfig = {
  /* your config */
};

export default withAfterpack(nextConfig);
```

A function config works too: `withAfterpack(async (phase, ctx) => ({ ... }))`. There is no
postbuild script: Next runs AfterPack itself, right after compiling and before prerendering and
export. A plain `next build` in CI produces obfuscated output,
and if obfuscation fails, `next build` fails.

AfterPack obfuscates the client chunks in `.next/static/chunks`. With `output: "export"`, the
obfuscated chunks are what lands in `out/`. Server code in `.next/server` never reaches the browser
and is left as is. The plugin also removes `.js.map` files from the client output, since a served
source map gives your source away.

## Check a deploy

Each build writes `.next/.afterpack-protection.json`, a receipt with a hash per obfuscated file.
Run `npx afterpack verify .` before you deploy. It fails when the receipt is missing, belongs to a
different build, or a file changed after obfuscation.

## Options

Pass them as the second argument: `withAfterpack(nextConfig, { preset: "hard", seed: "git" })`.

| Option | Type | Default |
| --- | --- | --- |
| `preset` | `"minify"`, `"light"`, `"medium"`, `"hard"`, `"extreme"` | `"light"` |
| `complexity` | `number` | the preset's value |
| `seed` | `number` or `string` (`"git"` uses the current commit) | a new random seed per build |
| `protectionMap` | `boolean` | on when Next emits browser source maps |
| `sourceMap` | `boolean` | on in development when an input map exists, off in production |
| `sourceMap.emitUrl` | `boolean` | on in development, off in production |
| `build.backup` | `boolean` | `false`; `true` keeps a `.backup.<hash>.js` copy of each original |
| `directives` | `boolean` | `true` |
| `build.autorun` | `boolean` | `true`; `false` turns AfterPack off |
| `production` | `boolean` | detected; `next build` sets `NODE_ENV=production` |

Dotted names are nested objects: `build.backup` is `{ build: { backup: true } }`. Every other key
in the [configuration reference](https://www.afterpack.dev/docs/config) works too.

`/* @afterpack */` [directives](https://www.afterpack.dev/docs/directives) and a readable
[Protection Map](https://www.afterpack.dev/docs/protection-map) both need
`productionBrowserSourceMaps: true` in your Next config. The Protection Map is written to
`.afterpack/`, which the plugin adds to your `.gitignore`. It contains your original source, so
never deploy or commit it.

Options can also live in `afterpack.json` or in `AFTERPACK_*` environment variables. The options
object wins over the environment, which wins over the file. An unknown or misspelled key fails the
build and names the right spelling.

## Your own build hook

If your config already sets `compiler.runAfterProductionCompile`, it still runs, before AfterPack.
A hook that uploads source maps to an error tracker will upload maps of the code before
obfuscation.

## Limitations

`experimental.sri` is not supported. Next computes integrity hashes before AfterPack runs, so the
browser would block the obfuscated chunks. The build stops with an error that says so.

## Pro

Without a key, AfterPack runs on your machine and applies basic protection. Set `AFTERPACK_KEY` in
your environment and the same plugin sends the build to AfterPack's cloud, which applies much
stronger protection. Keep the key out of `next.config.ts`: the plugin rejects it there. See
[AfterPack Pro](https://www.afterpack.dev/docs/pro).

## Links

- [Next.js setup guide](https://www.afterpack.dev/docs/frameworks/nextjs)
- [Presets and protection levels](https://www.afterpack.dev/docs/presets)
- [How AfterPack compares to other obfuscators](https://www.afterpack.dev/docs/comparison)
- [Protecting paywall checks in client code](https://www.afterpack.dev/docs/use-cases/paywall-checks)

## License

Apache-2.0. The engine it runs, `@afterpack/core`, has its own
[license](https://www.afterpack.dev/license).

## Feedback

Questions and ideas: [GitHub Discussions](https://github.com/afterpack-dev/afterpack/discussions).
Bugs: [GitHub Issues](https://github.com/afterpack-dev/afterpack/issues).
