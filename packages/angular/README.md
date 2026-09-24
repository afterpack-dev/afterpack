# @afterpack/angular

Obfuscate an Angular 17+ build. `@afterpack/angular` runs the
[AfterPack](https://www.afterpack.dev) JavaScript obfuscator over the browser bundle that `ng build`
writes.

Angular's application builder has no plugin hook, so AfterPack runs as a step after `ng build`.

## The simplest setup: the CLI

You do not need this package for the common case. Add the
[`afterpack` CLI](https://www.npmjs.com/package/afterpack) after `ng build`:

```jsonc
// package.json
{
  "scripts": {
    "build": "ng build && afterpack dist/my-app/browser --seed=git"
  }
}
```

## Using this package

Use this package when you prefer a Node script. It finds `dist/<app>/browser` for you.

```sh
npm install --save-dev @afterpack/angular
```

```ts
// scripts/obfuscate.mjs, run after ng build
import { afterpackAngular } from "@afterpack/angular";

await afterpackAngular({ seed: "git" });
```

Each JavaScript file is obfuscated in place. If obfuscation fails, the promise rejects.

## Options

| Option | Type | Default |
| --- | --- | --- |
| `preset` | `"minify"`, `"light"`, `"medium"`, `"hard"`, `"extreme"` | `"light"` |
| `complexity` | `number` | the preset's value |
| `seed` | `number` or `string` (`"git"` uses the current commit) | a new random seed per build |
| `protectionMap` | `boolean` | on when the build emitted source maps |
| `sourceMap` | `boolean` | on in development when an input map exists, off in production |
| `build.backup` | `boolean` | `false`; `true` keeps a `.backup.<hash>.js` copy of each original |
| `build.autorun` | `boolean` | `true`; `false` turns AfterPack off |
| `production` | `boolean` | detected from `NODE_ENV=production` or `CI=true` |
| `cwd` | `string` | `process.cwd()` |
| `distRoot` | `string` | `"dist"` |
| `browserDir` | `string` | found under `distRoot`; set it when there are several apps |

Dotted names are nested objects: `build.backup` is `{ build: { backup: true } }`. Every other key
in the [configuration reference](https://www.afterpack.dev/docs/config) works too, except
`directives`: the build output is already minified, so `/* @afterpack */` comments are gone by the
time AfterPack sees it. Setting `directives` fails with an explanation.

Options can also live in `afterpack.json` or in `AFTERPACK_*` environment variables. The options
object wins over the environment, which wins over the file. An unknown or misspelled key fails the
run and names the right spelling.

## Limitations

Because AfterPack runs after `ng build`, the readable bundle sits in `dist/` until the step
finishes, and stays there if it fails. Projects on the older webpack-based builder can use
[`@afterpack/webpack`](https://www.npmjs.com/package/@afterpack/webpack) through a custom builder
instead.

## Pro

Without a key, AfterPack runs on your machine and applies basic protection. Set `AFTERPACK_KEY` in
your environment and the same step sends the build to AfterPack's cloud, which applies much stronger
protection. See [AfterPack Pro](https://www.afterpack.dev/docs/pro).

## Links

- [Angular setup guide](https://www.afterpack.dev/docs/frameworks/angular)
- [Presets and protection levels](https://www.afterpack.dev/docs/presets)
- [Obfuscate your build in CI](https://www.afterpack.dev/docs/builds)
- [How AfterPack compares to other obfuscators](https://www.afterpack.dev/docs/comparison)
- [Protecting pricing logic](https://www.afterpack.dev/docs/use-cases/pricing-logic)

## License

Apache-2.0. The engine it runs, `@afterpack/core`, has its own
[license](https://www.afterpack.dev/license).

## Feedback

Questions and ideas: [GitHub Discussions](https://github.com/afterpack-dev/afterpack/discussions).
Bugs: [GitHub Issues](https://github.com/afterpack-dev/afterpack/issues).
