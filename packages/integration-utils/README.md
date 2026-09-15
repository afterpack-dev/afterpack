# @afterpack/integration-utils

The framework-integration helpers the AfterPack plugins (`vite`, `next`, `webpack`, `rollup`,
`esbuild`, `parcel`, `angular`, `electron`) and the `afterpack` CLI share. The engine call itself
(`@afterpack/core`'s `process`) stays in each plugin; this package owns everything *around* it —
resolving one validated configuration from the four places, discovering an upstream source map,
capturing `@afterpack` directives, running the obfuscation pass, and writing the artifacts (backup,
`.map`, `protectionMap.html`) with the `.gitignore` + public-path guardrails.

It carries **no runtime dependency on `@afterpack/core`** (types only), so it stays trivially testable
with the engine mocked.

## API

The package index is the public surface and nothing more: exactly the names the shipped plugins and
the CLI import, plus the types their signatures name. `src/index.guard.test.ts` fails when it grows,
so a helper that only this package uses stays on its own module and never becomes API by accident.

**Configuration** — one schema, four places (`afterpack.json`, plugin options, `--flags`,
`AFTERPACK_*`), spelled identically in each.

- `resolvePluginConfig({ label, options, argv, cwd, env, localKeys, unsupported }) →
  { config, options, engineConfig, configFile, positionals, help, version }` — the ONE resolver every
  front door calls, plugins and the CLI and the Next build hook alike. Fail-closed: any rejected key
  throws rather than silently reverting one setting to its default. Precedence, most specific first:
  the options object and a `--flag` (one rank — the same key in both is a reported conflict), then
  `AFTERPACK_*`, then `afterpack.json`.
- `loadConfigFile(dir)` — the `afterpack.json` nearest-ancestor loader on its own.
- `parseCliOptions(argv)` / `parseEnvOptions(env)` — the one `key.path=value` parser behind `--key=value`
  and `AFTERPACK_key_path`.
- `validateConfig(input, surface)`, `normalizePluginOptions(input, localKeys, surface)`,
  `mergeConfig`, `getPath`, `toEngineConfig`, `toPluginOptions`, `CONFIG_KEYS` — the registry itself.

**The pass**

- `runObfuscationPass(options) → ObfuscationPassResult` — collect, obfuscate, write, report. Everything
  a plugin does once the bundler's output is final. Two shapes: an ON-DISK caller passes `files` and
  the pass rewrites each one in place; an IN-PIPELINE caller passes `inputs` (bytes + live map, per
  path) plus `emitToCaller` and gets the obfuscated code back on `result.outputs`, so the bundler
  never writes the cleartext bundle.
- `collectBundleJs(bundle, outDir)` / `applyBundleOutput(bundle, entry, out, policy)` — the Rollup
  output-bundle seam `@afterpack/rollup` and `@afterpack/vite` share: which entries are this build's
  JS, and how one engine result goes back onto an entry (map replaced, or dropped when policy ships
  none). Structurally typed — this package takes no `rollup` dependency.
- `withSourceMappingURL(code, url)` — re-issue or drop a `sourceMappingURL` trailer. What
  `writeArtifacts` does on disk, for a caller that hands its bundler a string.
- `collectJsFiles(target, { include })` / `collectSourceMaps(dir)` — the on-disk walk `paths.include`
  re-admits into. A front door with no walk REFUSES `paths.include` rather than accepting and
  dropping it.
- `applyResolvedKey(config, env)` — converge every spelling of the Pro `key` onto `AFTERPACK_KEY`,
  the only one the engine reads. `resolvePluginConfig` calls it; a front door that resolves its own
  configuration (a Parcel Optimizer) has to.
- `scanDirectives(source) → DirectiveManifest` — `/* @afterpack key=value */` capture from original source.
- `discoverInputSourceMap(jsPath, code?) → string | null` — adjacent `<file>.map` → `sourceMappingURL`
  comment (relative/absolute path resolved from disk, `data:` URI decoded inline) → none. **Never**
  network-fetches a remote URL. `extractSourceMappingURL(code)` is the comment reader alone, and
  `decodeDataUri(url)` the inline decoder.
- `resolveReportPolicy(env, artifactOptions, signals) → { protectionMap, sourceMap, emitSourceMappingURL, backup, … }`
  — the opt-out defaults + production auto-flip (`NODE_ENV=production` / `CI=true` / explicit hint).
- `buildEngineConfigJson({ filePath, inputSourceMap, policy, seed, engine }) → string` — the engine
  `configJson`.
- `writeArtifacts({ outPath, code, sourceMapJson, protectionMapJson, originalSource, policy, mode })` —
  writes the backup, the code (+ optional `//# sourceMappingURL` append), the `.map`, and — in
  `single` mode — the per-file `protectionMap.html`.
- `createTelemetryReporter(deps) → TelemetryReporter` — the reporter every front door wires; it
  fires only when a build reports an error-level diagnostic (a refused or partial build), never on
  a clean build.

**The protection receipt**

- `writeProtectionReceipt({ dir, tool, engineVersion, seed, seedOrigin, bundler, buildId, files }) → path`
  and `verifyProtectionReceipt(dir, expectedBuildId?) → { receiptPath, receipt, problems }` — the
  `.afterpack-protection.json` listing a sha256 per obfuscated file. `runObfuscationPass` writes it
  itself whenever it writes to disk, into the directory it walked, after the last file is written —
  so a throwing run leaves none, and `receipt: { bundler, buildId }` is all a front door adds.
  `afterpack verify <dir>` reads it back. It answers what a config-time flag file cannot: the pass
  never ran, the tree was rebuilt without the wrapper, or a file was replaced after the build. It is
  also what `detectAlreadyObfuscatedInputs` matches inputs against, so a second run over an
  unrebuilt tree is refused. No timestamp — a rebuild at the same seed must stay byte-identical.

## The policy (opt-OUT + production auto-flip)

Defaults are **ON** so users see AfterPack's real result on the first try. Production (detected from
`NODE_ENV=production`, `CI=true`, or a framework prod hook) flips the safe defaults: Protection Map
**OFF** (it embeds original source; if force-enabled in prod it goes to a gitignored `.afterpack/`
with a loud warning), the source-map `.map` sibling **kept** but the `//# sourceMappingURL` comment
**omitted**, and the backup **OFF** (the pass writes in place, so a `.backup.<hash>` copy of your
original source would ship into the deployable tree). Every default is overridable with a single
option, written at its registry path — `protectionMap.enabled`, `sourceMap.emitUrl`, `build.backup` —
or, for a group with an `enabled` child, as a bare boolean on the group: `protectionMap: false` is
`protectionMap: { enabled: false }`.

## Feedback

Questions and proposals: https://github.com/afterpack-dev/afterpack/discussions · Bugs: https://github.com/afterpack-dev/afterpack/issues
