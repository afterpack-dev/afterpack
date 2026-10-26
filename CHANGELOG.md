# Changelog

The full changelog, including cloud and dashboard changes, is at https://www.afterpack.dev/changelog.

## 1.0.2 - 2026-10-26

Classic-script scoping and direct `eval` fixes

### Fixed

- **Engine:** A function declared inside a block at the top of a classic script, such as `{ function g() {} }` or a labelled one, is a global again after protection, so other scripts on the page can call it.
- **Engine:** Code that calls `eval` directly keeps seeing the page's globals: a name AfterPack adds can no longer stand in for a global the evaluated code reads or writes, and a variable the evaluated code declares stays in its function's scope. Files that build their `eval` code at runtime, or use `with`, come out larger, because AfterPack gives its own names a form no page global can share.
- **Engine:** `if (x) function f() {}` in a script that is not a module is accepted, as browsers accept it. Declarations browsers reject there, such as `if (x) async function f() {}`, now fail the build with a parse error instead of passing through.
- **Engine:** A parenthesized string statement such as `('use strict');` no longer makes its function strict.
- **Engine:** A `var` inside a class `static {}` block stays local to that block.

## 1.0.1 - 2026-10-24

One receipt for several builds, and release notes in every package

### Added

- **CLI:** `afterpack verify` also counts the JavaScript files in the directory that the receipt doesn't list, such as scripts your pipeline copies in. The count is information only and never changes the exit code. ([Files the receipt doesn't list](https://www.afterpack.dev/docs/cli#files-the-receipt-doesnt-list))
- **CLI:** Every `--diagnostics.format=json` document starts with `schemaVersion: 1`.
- **Plugins:** Every package ships a `CHANGELOG.md`, and each GitHub release carries its release notes.

### Changed

- **Docs:** The presets page explains why output size changes between builds and how to set a size budget. ([Size budget](https://www.afterpack.dev/docs/presets#size-budget))

### Fixed

- **Plugins:** Several AfterPack builds into one output directory now share one protection receipt, so `afterpack verify` checks the files of every build. Before, each build replaced the receipt and `verify` checked only the last one. If you merged receipts yourself to work around this, you can remove that step. ([Several builds into one directory](https://www.afterpack.dev/docs/cli#several-builds-into-one-directory))
- **Plugins:** `require("@afterpack/vite/package.json")` and the same for every other package now resolve.

## 1.0.0 - 2026-10-23

AfterPack 1.0, Vite 6 or newer and engine 1.0.0

### Added

- **CLI:** The build log names the engine version that ran: your installed `@afterpack/core` for a local build, or the cloud engine for a Pro build. The CLI's "Protected" summary ends with it too.
- **Cloud:** status.afterpack.dev shows whether the API and the website are up, with 90 days of daily uptime. `GET /v1/status` returns the same data. ([Status API](https://www.afterpack.dev/docs/status-api))

### Changed

- **Engine:** The engine, the CLI and all 13 plugins are now 1.0.0. Across 1.x, your configuration, CLI commands, exit codes and plugin options keep working as they do today. Output bytes may change between releases, but the protected program behaves the same.
- **Plugins:** Upgrade every AfterPack package together: the 1.0 CLI and plugins refuse an `@afterpack/core` older than 1.0.
- **Cloud:** Pro cloud builds need AfterPack 1.0: the CLI, the plugins, `@afterpack/core` or `@afterpack/wasm`. The cloud refuses a 0.x client and names the command to upgrade. From 1.0 on, the cloud keeps serving every released 1.x client. ([Pro](https://www.afterpack.dev/docs/pro))
- **Plugins:** The Protection Map lists each readable string once, with a count, and Show in code steps through every place it appears. Property names, which usually have to stay readable, no longer count as weak spots.
- **Cloud:** Pro builds now run engine 1.0.0.
- **Docs:** Every package README checks a build with `npx afterpack@latest verify` and says when a Protection Map is written. ([Protection Map](https://www.afterpack.dev/docs/protection-map))

### Fixed

- **Engine:** React Router 7 framework-mode apps now hydrate: a function declared inside a block in strict-mode code no longer breaks a reference to the same name elsewhere in its function.
- **Engine:** A function that declares a nested function named like one of its parameters no longer fails to load with "Identifier has already been declared".
- **Engine:** A `'use strict'` that comes after other code in a function, or is written with escapes, no longer turns on strict mode.
- **Plugins:** Every plugin's protection receipt now records the bundler that built the output instead of `unknown`.
- **Plugins:** The Protection Map's directive legend lists only the directives that exist today. A map saved by an older version still opens.

### Removed

- **Plugins:** Vite 5 support: `@afterpack/vite`, `@afterpack/vue`, `@afterpack/svelte`, `@afterpack/sveltekit` and `@afterpack/electron` now need Vite 6, 7 or 8.
- **Plugins:** Svelte 4 and SvelteKit 1 support, since they run only on older Vite: `@afterpack/svelte` needs Svelte 5 and `@afterpack/sveltekit` needs SvelteKit 2.

## 0.2.7 - 2026-10-19

Stricter region directives on Free, `key` in core and engine 0.2.8

### Added

- **Engine:** A tool that wraps `@afterpack/core` or `@afterpack/wasm` can name itself in cloud calls through the `client` option.

### Changed

- **Docs:** The directive docs now say plainly that per-region directives are a Pro feature; Free controls whole files through `paths.exclude`.

### Fixed

- **Engine:** A Free build now stops when a region directive raises `inflation.max` above the build's budget, like every other directive that adds protection.
- **Engine:** The secrets report no longer flags constant names such as `MAX_RETRIES` as keys, and now flags licence keys and UUIDs.
- **Engine:** `@afterpack/core` accepts `key` in the config, as its readme and types say.

## 0.2.6 - 2026-10-17

More strings encoded, corrected Protection Map classes and engine 0.2.7

### Changed

- **Engine:** The Protection Map now labels control-flow flattening, mixed boolean arithmetic, opaque predicates, cross-dependency entanglement and integer-expression bytecode as renamed & encoded (polynomial-injective), not flattened & fused. A static attacker can recover the original structure from each of them, so no transform that ships today is labelled flattened & fused. The transforms themselves are unchanged. ([Reversal classes](https://www.afterpack.dev/docs/reversal-classes))
- **Engine:** `obfuscate` and `obfuscateAll` in `@afterpack/core`, and `@afterpack/wasm`, now send their package name and version with each cloud build, as the CLI and plugins already do.
- **Cloud:** Large Pro builds finish sooner: the cloud builds several of their files in parallel.
- **Cloud:** Pro builds now run engine 0.2.7.
- **Docs:** The threat model and performance pages now give measured results, including how well AI models reverse protected code and what each preset costs at runtime. The package READMEs now say what self-integrity checks. ([Threat model](https://www.afterpack.dev/docs/threat-model), [Performance](https://www.afterpack.dev/docs/performance))
- **Docs:** The CLI page covers content-hashed renames, per-directory backups, interrupted runs and locks. ([CLI](https://www.afterpack.dev/docs/cli))

### Fixed

- **Engine:** Strings inside the object of a member assignment, such as `(r = class { … }).p = v` in minified libraries, are now encoded. They used to stay readable at every preset. Bundles that include such libraries now ship far fewer readable strings. Large bundles take a few percent longer to build.
- **Engine:** With a Pro key, a region set to `medium` or above in a `light` build now gets `medium`'s string encoding, keyed to a shared runtime value, and so does the rest of that file. Its strings used to keep `light`'s encoding. ([Directives](https://www.afterpack.dev/docs/directives))
- **Plugins:** `@afterpack/next` no longer warns that the build id is pinned when Next.js generated it. About half of default builds got that warning.
- **Cloud:** Security scanner: a site no longer gets the "Protected by AfterPack" badge when a script it loads with `fetch()` or XHR could not be read.
- **Cloud:** Protection Maps opened from a cloud build now show coverage and reversal-class labels, like the local report, with no resistance percentage.

## 0.2.5 - 2026-10-16

CLI renames content-hashed files, safer restore and engine 0.2.6

### Added

- **CLI:** On Next.js, Angular, Vite and webpack output, the CLI now renames each content-hashed file to match its obfuscated bytes and rewrites every reference to it, as the plugins do. Other output keeps its names and prints a notice. ([Content-hashed file names](https://www.afterpack.dev/docs/cli#content-hashed-file-names))

### Changed

- **CLI:** `afterpack restore` returns the original tree byte for byte, renames included, and finishes a run that was stopped partway. A new run refuses until an interrupted one is restored. Output files are written through a temporary file, so a killed run never leaves a half-written file. Restore refuses a file that was rebuilt since the run and says how to recover. ([A run that stopped partway](https://www.afterpack.dev/docs/cli#a-run-that-stopped-partway))
- **CLI:** Backups are kept per build directory in `.afterpack/backups/`, each with a lock, so parallel runs over one directory are refused and separate apps in one repository keep separate backups. A backup in the old `.afterpack/backup/` still restores. ([Parallel runs and locks](https://www.afterpack.dev/docs/cli#parallel-runs-and-locks))
- **Plugins:** `@afterpack/angular` tells the engine which files are ES modules and which are classic scripts, so a build that mixes them no longer falls back to `auto` for every file. ([sourceType](https://www.afterpack.dev/docs/config#sourceType))
- **Engine:** When `@afterpack/wasm` runs out of memory, it now fails with `DIAG_OUT_OF_MEMORY` and says how to fix it, instead of a generic internal-limit error.
- **Cloud:** Pro files that need more memory than a regular cloud build has now run on a larger build machine instead of failing.
- **Cloud:** Pro builds now run engine 0.2.6.
- **Docs:** Performance lists what the missing-global check costs at each preset. ([Performance](https://www.afterpack.dev/docs/performance))

### Fixed

- **Cloud:** Absolute local paths that earlier CLI and plugin versions sent with cloud builds are removed from stored diagnostics and Protection Maps.

## 0.2.4 - 2026-10-14

Hashed names follow obfuscated bytes, no source maps in production and engine 0.2.5

### Added

- **Plugins:** `@afterpack/next` warns when a fixed build id keeps `_buildManifest.js` and `_ssgManifest.js` on the same cached URL across releases.
- **CLI:** `afterpack verify` checks a framework's deploy copy of its output, such as SvelteKit's `build/`, Nuxt's `.output/public/` or a Next.js static `out/`.
- **Engine:** `obfuscate`, `obfuscateAll` and `processBatch` accept a `sourceType` for each file, for builds that mix ES modules and classic scripts. `@afterpack/angular` now says when its whole output is ES modules. ([sourceType](https://www.afterpack.dev/docs/config#sourceType))
- **Cloud:** A Pro build with `protectionMap.enabled` now prints a link to its Protection Map in the dashboard, or says that none was stored. ([Protection Map](https://www.afterpack.dev/docs/protection-map))

### Changed

- **Plugins:** Precompressed `.gz` and `.br` copies now hold the obfuscated code, and Angular's integrity attributes and service-worker hashes are recomputed from it. The Vite and webpack plugins refuse a build that also runs a subresource-integrity plugin, whose hashes would pin the unobfuscated bytes.
- **Engine:** At `medium` and above, the integer-expression interpreter runs faster in hot loops, and its code is smaller.
- **Cloud:** Pro builds now run engine 0.2.5.
- **Dashboard:** Billing activity shows what each payment charged, tax included, and long payment references no longer overflow its details card.
- **Docs:** Builds gains File names and caching, and the CLI and framework pages cover the new naming, source-map, receipt and integrity behavior.

### Fixed

- **Plugins:** In the Vite, Rollup, webpack, esbuild, Next.js and Angular plugins, content-hashed file names now follow the obfuscated bytes, so a name never points at different code from one build to the next. Obfuscated files used to ship under the plain build's names, so immutable caches and service workers could keep serving the previous file. A fresh seed now renames every obfuscated file, and a constant seed keeps unchanged files cached. ([File names and caching](https://www.afterpack.dev/docs/builds#file-names-and-caching))
- **CLI:** Every build is now production unless it says development, and production builds delete the bundler's source maps, CSS maps included. A local `npx afterpack dist/` used to leave maps that contained your original source. A build is development only with `build.mode` set to `development` or `NODE_ENV=development`. A map that cannot be removed fails the build. The CLI and every plugin behave the same way. ([build.mode](https://www.afterpack.dev/docs/config#build-mode))
- **CLI:** The protection receipt is now written to `.afterpack/receipts/` instead of the build output, so it no longer ships with your site. A leftover `.afterpack-protection.json` is removed. `.afterpack/` sits next to the nearest lockfile, `afterpack.json` or `.git` above the build directory, so every working directory and plugin finds the same one, and a second run over protected output is refused from anywhere. ([Files](https://www.afterpack.dev/docs/cli#files))
- **CLI:** Cloud builds now name files by their path inside the build directory, never by an absolute path with your home directory or username. Local output is unchanged.
- **CLI:** `afterpack audit` refuses a local path such as `./dist` instead of sending it to the scanner as a URL.
- **Cloud:** The cloud no longer stores or logs the absolute local paths that earlier CLI and plugin versions send.

## 0.2.3 - 2026-10-11

Fail-closed builds, new exit codes and engine 0.2.4

### Changed

- **Plugins:** Update `afterpack` and your `@afterpack/*` plugins to 0.2.3 together with the engine. Versions 0.2.2 and earlier fail every file with engine 0.2.4, which a fresh install or a lockfile update can pull in. With an older CLI or plugin, each file fails with "the engine result does not say whether the file was obfuscated". Upgrading the CLI and plugins fixes it.
- **Engine:** In `@afterpack/core`, a file whose output fails to re-parse now fails with `DIAG_OUTPUT_UNPARSEABLE` and no code, instead of returning the original source. The `unobfuscated` result field is removed. ([Diagnostics](https://www.afterpack.dev/docs/diagnostics#complete-reference))
- **CLI:** The CLI exits `4` when a `regions` entry needs a Pro key and `5` when a runtime-reflection pattern is not acknowledged. Both exited `1` before. ([Exit codes](https://www.afterpack.dev/docs/diagnostics#exit-codes))
- **Engine:** An unacknowledged runtime-reflection pattern now fails with `DIAG_REFLECTION_NOT_ACKNOWLEDGED`, and the message names the `reflection.allow` value to add. The code used to be the pattern's name. ([reflection.allow](https://www.afterpack.dev/docs/config#reflection-allow))
- **Engine:** At `medium` and above, 32-bit constants from `0x80000000` to `0xFFFFFFFF`, such as hash seeds, are now encoded like other integers instead of appearing as written.
- **Engine:** At `medium` and above, more bitwise `&` and `|` expressions are transformed, including `BigInt` ones such as `(n >> i) & 1n`.
- **Engine:** At `light`, encoded strings no longer come out looking like words.
- **Engine:** The string decoder's setup code now varies from build to build instead of being spelled the same in every output.
- **Cloud:** Pro builds now run engine 0.2.4.
- **Docs:** Diagnostics, CLI and Directives cover exit codes `4` and `5`, and say when `DIAG_INFLATION_BUDGET_HIT` fires.

### Fixed

- **Engine:** Free builds no longer refuse a region that turns on `strings.encode` when string encoding is already on, as it is at `light` and above. ([Free builds](https://www.afterpack.dev/docs/directives#free-builds))
- **Engine:** With `identifiers.methods.rename: false`, a class method that uses an outer variable with the same name as the method now reads that variable, not the method itself. ([identifiers.methods.rename](https://www.afterpack.dev/docs/config#identifiers-methods-rename))

### Removed

- **CLI:** `allowUnobfuscated` is removed: a file the engine cannot protect always fails the build and never ships as the original source. The CLI, the plugins and `afterpack.json` now reject it as an unknown option, so remove it if you set it. The CLI no longer exits `2`. ([Fail closed](https://www.afterpack.dev/docs/diagnostics#fail-closed-no-exceptions))

## 0.2.2 - 2026-10-03

Correctness fixes and engine 0.2.3

### Added

- **Plugins:** The plugins and the CLI tell the engine when your build output is ES modules, from the bundler's output format or, in the CLI, from `.mjs` files and `<script type="module">` in your built HTML. The new `sourceType` option overrides it. ([sourceType](https://www.afterpack.dev/docs/config#sourceType))
- **Docs:** A new Semantic contract page lists what obfuscated output keeps the same and the few deliberate differences. Diagnostics, Presets and Directives cover engine 0.2.3 behavior.

### Changed

- **Engine:** A build that cannot reach its complexity target because a transform is turned off or a region directive limits it now fails with `DIAG_TARGET_NOT_REACHED`, naming the file and lines. Before, it shipped weaker output.
- **Engine:** Pro: `transforms.selfIntegrity` on a build with no code at `medium` or above now fails with `DIAG_SELF_INTEGRITY_INERT` instead of shipping without the check.
- **Engine:** `minify` now only renames identifiers and compresses the code. It no longer rewrites syntax. ([Presets](https://www.afterpack.dev/docs/presets))
- **Engine:** Loops are no longer rewritten into callback helpers at `minify` and `light`, which removes the 2-5x slowdown those helpers caused in hot loops. At `light`, property and global names still go through encoded constants, which has some cost in very hot code.
- **Engine:** `light` output is smaller: about 30% less gzipped on real bundles, most of all on string-heavy files such as translation tables.
- **Engine:** The engine is smaller: `@afterpack/wasm` downloads about 17% fewer gzipped bytes.
- **CLI:** The Protection Map shows coverage: each region lists the transforms applied to it and why any code stays readable. It no longer shows a resistance percentage. ([Protection Map](https://www.afterpack.dev/docs/protection-map))
- **Cloud:** Pro builds now run engine 0.2.3.

### Fixed

- **Engine:** Fixed cases where obfuscated code could behave differently from the original, at every preset. Most date back to 0.1, so rebuild with this release. Each engine release is now checked against real libraries and multi-script pages before it ships. The items below list the fixes; the new Semantic contract page lists what output keeps the same and the few deliberate differences. ([Semantic contract](https://www.afterpack.dev/docs/semantic-contract))
- **Engine:** Classic scripts keep their top-level functions and variables on the global object, so other scripts on the page can still use them, and references to globals declared elsewhere behave as in the original.
- **Engine:** An ES module with no `import` or `export` is no longer read as a classic script when a plugin, the CLI or the `sourceType` option says the output is ES modules, so its top-level names stay off `window`. With none of those, the engine still tells the kind from the syntax, and a file without `import` or `export` is read as a classic script.
- **Engine:** Values inside template literals are converted to text the way the original does, so objects such as dates format correctly.
- **Engine:** Functions your code later constructs, through `extends`, a `Proxy`, a stored reference or an export, stay constructible.
- **Engine:** Class fields are defined the way native fields are, so a field over an inherited accessor works, as in custom elements, and a class called without `new` throws.
- **Engine:** A function that refers to itself keeps one identity, so an event listener that removes itself is removed.
- **Engine:** `BigInt` arithmetic no longer throws or returns wrong values at `medium` and above, a regression in 0.2.
- **Engine:** At `medium` and above, arithmetic converts each object operand once, as the original does, and output no longer breaks when another script changes `valueOf` or `toString` on shared objects.
- **Engine:** Direct `eval` and `with` keep their scope: the code around them stays as written, and the build reports it with `DIAG_DYNAMIC_SCOPE_NATIVE`. ([Diagnostics](https://www.afterpack.dev/docs/diagnostics))
- **Engine:** Classes and constructors keep their original name when your code reads `this.constructor.name` or `new.target.name`, so custom error classes report their own name. ([Semantic contract](https://www.afterpack.dev/docs/semantic-contract#deliberate-differences))
- **Engine:** Also fixed: `async` ordering, a `catch (e)` block that declares `var e`, optional calls in parentheses such as `(o?.m)()`, `delete` in strict code, nested loops that multiplied output size at `medium` and above, and constant `**` results that could differ from the browser in the last digit.
- **Engine:** An explicit `inflation.max` now checks the finished file and fails the build with `DIAG_SIZE_CAP_REACHED` when output reaches it. String encoding always completes first. In earlier versions, a tight `inflation.max` could stop string encoding early and leave some strings readable, reported only as an Info diagnostic. If you set `inflation.max`, rebuild with this release. ([inflation.max](https://www.afterpack.dev/docs/config#inflation-max))
- **Engine:** Free builds no longer refuse a directive that only lowers protection, such as a transform mask or a lower preset. Like other directives on Free, it is ignored. ([Free builds](https://www.afterpack.dev/docs/directives#free-builds))

## 0.2.1 - 2026-10-01

CSS source maps, Parcel receipts and engine 0.2.2

### Added

- **Plugins:** Parcel builds now get a protection receipt, so `afterpack verify` works for them. Add `--reporter @afterpack/parcel-optimizer/reporter` to your `parcel build` command.

### Changed

- **Engine:** Engine 0.2.2 is a build-only release: its output is the same as 0.2.1. Pro builds run it too.

### Fixed

- **Plugins:** `@afterpack/next` now deletes CSS source maps from `.next/static` along with the JavaScript ones, and strips the comments that point to them. Earlier versions removed only JavaScript maps, so with `productionBrowserSourceMaps` on, your original stylesheets could be served with the site. The webpack, Rollup and Vite plugins now also drop CSS maps when your build ships no source maps. ([Next.js guide](https://www.afterpack.dev/docs/frameworks/nextjs))

## 0.2.0 - 2026-09-30

Per-token presets and engine 0.2.1 (breaking)

### Changed

- **Engine:** Presets are recalibrated for per-token protection: `medium`, `hard` and `extreme` now apply their complexity target (7, 12 and 25) to every token, where 0.1 targeted an average across the file. Output at these presets is considerably larger than in 0.1, and presets no longer cap output size. If you set `complexity` yourself, review the value, because it is now a per-token target. `light`, the default, adds no structural layers: it encodes strings, renames identifiers and rewrites syntax, and its output is about the same size as in 0.1. ([Presets](https://www.afterpack.dev/docs/presets))
- **Plugins:** The Protection Map now shades each token by how much transformation it received and lists the declarations the engine rewrote, in local reports and in the dashboard. ([Protection Map](https://www.afterpack.dev/docs/protection-map))
- **Plugins:** The CLI and plugins now require engine 0.2 or newer and refuse an older one. `preset=` directives resolve on the new scale.
- **Plugins:** The CLI and plugins no longer edit your project's `.gitignore`, because `.afterpack/` now carries its own. In CI, the Protection Map is off by default unless you set `protectionMap.enabled`.
- **Cloud:** Pro builds now run engine 0.2.1, and builds from 0.2 packages get up to 4 minutes in the cloud (was 90 seconds). If you use a Pro key, update the CLI or plugin too. A 0.1 package with no preset set, or with `preset=` directives, sends values on the old scale, so its cloud builds come out heavier than intended. ([Pro](https://www.afterpack.dev/docs/pro))
- **Docs:** Docs and package READMEs are updated for 0.2, including the preset scale, the Protection Map, and where each integration runs in your build.

### Fixed

- **Engine:** Fixed a miscompile in which code inside a rewritten `switch`, a `?.` or `??` expression, or a class with private fields could read the wrong variable. It depended on the build seed and on a variable's name, original or renamed, matching one the engine uses internally. Affected code could throw or return wrong values.
- **Engine:** Functions stored on objects now stay constructible. 0.1 could turn them into arrow functions, which broke feature detection in polyfill libraries such as core-js.
- **Engine:** `obfuscate()` and `obfuscateAll()` in `@afterpack/core` and `@afterpack/wasm` now draw a fresh seed for each build when you don't pass one. In 0.1, every build of the same source came out identical. The CLI and plugins were not affected. ([seed](https://www.afterpack.dev/docs/config#seed))
- **Engine:** Input nested too deeply to process safely now fails with a clear diagnostic instead of crashing `@afterpack/wasm`. A long-running `@afterpack/wasm` instance also no longer grows its memory with every file. ([Workers](https://www.afterpack.dev/docs/workers))

## 0.1.0 - 2026-09-25

CLI, framework plugins and engine

### Added

- **CLI:** `npx afterpack` protects a build directory or a single file in place. `verify` checks a build against its protection receipt before deploy, `restore` undoes the last run, and `audit` scans a live site. ([CLI](https://www.afterpack.dev/docs/cli))
- **Plugins:** Plugins for Vite, Next.js, webpack, Rollup, esbuild, Astro, Svelte, SvelteKit, Vue, Nuxt, Angular, Electron and Parcel. ([Framework guides](https://www.afterpack.dev/docs/frameworks))
- **Engine:** `@afterpack/core` runs locally on macOS, Linux (x64 and arm64, glibc and musl) and Windows x64. `@afterpack/wasm` runs the same engine in Cloudflare Workers and Node. ([Workers](https://www.afterpack.dev/docs/workers))
- **Plugins:** The Protection Map is a local HTML report that shows what each part of your code went through. It is written to `.afterpack/` when your build has source maps. ([Protection Map](https://www.afterpack.dev/docs/protection-map))
- **Docs:** The CLI and plugins are open source under Apache-2.0. The engine is free to use under the AfterPack Engine License. ([License](https://www.afterpack.dev/license))
