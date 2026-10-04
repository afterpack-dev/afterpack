# End-to-end suite

Each `packages/*/e2e/<fixture>/` is a small app with its own bundler and lockfile. The suite
builds it with the real plugin and the real `@afterpack/core`, checks the output, and drives it in
a browser. `e2e/helpers/registry.ts` lists the fixtures. `playwright.config.ts` gives each fixture
one project per browser, named `<fixture>`, `<fixture>@firefox` and `<fixture>@webkit`.

## Running it

```bash
pnpm e2e:install   # npm ci in each fixture; skips a fixture whose lockfile has not changed
pnpm e2e:quick     # build the fixtures, then run the @quick tests in Chromium
pnpm e2e           # build the fixtures, then run every test (Chromium unless told otherwise)
pnpm e2e:build     # build only; `npx playwright test …` then reruns against those builds
```

`pnpm e2e` and `pnpm e2e:quick` build every selected fixture in parallel, heaviest first, before
Playwright starts. Playwright only serves the builds. Arguments after the script name go to
`playwright test`, but the build step always covers the whole selection, so narrow the selection
with an environment variable:

| Variable | Effect |
|---|---|
| `AFTERPACK_E2E_FIXTURES=vite-react,next-app-webpack` | only these fixtures: install, build, serve, test |
| `AFTERPACK_E2E_SHARD=2/4` | one slice of four, balanced by the `weight` in the registry; fixtures that share a directory stay in the same slice |
| `AFTERPACK_E2E_BROWSERS=chromium,firefox,webkit` | the browsers to run (default `chromium`); CI's full lane runs all three |
| `AFTERPACK_E2E_BUILD_CONCURRENCY=3` | how many fixture builds run at once; the default is 3, or fewer on a small machine, and 1 on a self-hosted Actions runner |
| `AFTERPACK_E2E_WORKERS=2` | Playwright workers; the default is 2, and 1 on a self-hosted Actions runner |

A self-hosted runner (`RUNNER_ENVIRONMENT=self-hosted`) is usually a shared machine, so the suite
builds and tests one thing at a time there unless the two variables say otherwise.

Run the full lane as CI does with `AFTERPACK_E2E_BROWSERS=chromium,firefox,webkit pnpm e2e`, after
`npx playwright install chromium firefox webkit`.

## Lanes and tags

| Lane | Where | What |
|---|---|---|
| quick | every pull request, in four shards; a Windows and a macOS job over `vite-react`, `webpack-react`, `cli-vanilla-esm` and `next-app-webpack` (on a push to `main` too) | tests tagged `@quick`, in Chromium |
| full | a push to `main`, in four shards; `e2e-candidate.yml` for an engine candidate | every test, in Chromium, Firefox and WebKit |
| preset | `e2e-candidate.yml`, once per preset: medium, hard, extreme | `vite-react` and `next-app-webpack` built with `AFTERPACK_preset`, then `@scenario` and `@lane` in Chromium |
| Pro | `e2e-pro.yml`, once the API serves the candidate's Pro engine | `vite-react` and both `next-app` legs built with `AFTERPACK_KEY` on that cloud engine, then `@scenario` and `@lane` in Chromium |

- `@quick`: in the PR lane. Tag the tests that matter most for the fixture, and keep them fast.
- `@node`: needs no browser: build logs, receipts, signatures, source maps, Node-side checks. It runs
  once, in the Chromium project.
- `@scenario`: a differential user journey (see below).
- `@lane`: proves a candidate lane built what it claims (`e2e/helpers/lanes.ts`): every pass at
  `AFTERPACK_preset`, or, with `AFTERPACK_KEY`, a receipt from the cloud engine at
  `AFTERPACK_E2E_ENGINE_VERSION` and a directive region sent to it. Each check skips without its
  variable; an untagged `@node` test shows both checks rejecting the keyless default build.

Tests that rebuild a fixture in place, such as the determinism rebuild on `next-app-webpack` and
`electron-app`, are `@node`. A fixture's Firefox and WebKit projects depend on its Chromium project
(or on the first browser listed, when Chromium is not), which alone runs the `@node` tests, so a
rebuild never replaces files that another browser is still loading. Playwright runs a dependency
project whole: `--grep`, `--repeat-each` and `--project` do not narrow it, and a failure there skips
that fixture's other browsers. To repeat one Firefox test, select only that browser:
`AFTERPACK_E2E_BROWSERS=firefox AFTERPACK_E2E_FIXTURES=vite-react pnpm e2e --grep @scenario --repeat-each 5`.

## What every fixture proves

1. The build log shows an obfuscation pass that covered the expected files and changed at least one
   file (`expectObfuscationPass`).
2. The files its protection receipt names carry obfuscation signatures, not just minification
   (`expectObfuscationSignatures`). The thresholds sit well outside what engine 0.2.1 measured on
   all 20 fixture legs:

   | Signature (over the receipt's files) | Threshold | Protected | Unprotected |
   |---|---|---|---|
   | computed member accesses, share of all member accesses | ≥ 75% | 91–100% | 0–19% |
   | the same, per file with 20 or more member accesses | ≥ 60% | ≥ 82% | ≤ 32% |
   | computed member accesses per KB | ≥ 12 | 23–71 | 0–6.4 |
   | identifier occurrences of two characters or fewer | ≥ 80% | 87–99.9% | 3–98% |
   | mean identifier length | ≤ 2.6 | 1.53–2.16 | 1.30–5.83 |
   | wordy baseline literals that survive verbatim (fixtures with a baseline) | ≤ 15% | 0–0.5% | 100% |

   Only the member-access rows tell obfuscated output from minified output: every unprotected leg
   fails them, by a wide margin. A minifier already shortens identifiers, so minified unprotected
   bundles (Vite, webpack, Next, Nuxt, Astro, Angular, Vue, Svelte, Parcel) pass the two
   identifier rows. Those rows are a renaming check for the fixtures whose output is not minified
   (Rollup, esbuild, Electron, the CLI fixtures, SvelteKit's server output), where unprotected
   output fails them.

   The same check must fail on the unprotected baseline build, which proves it can fail.
3. The protected app renders, hydrates and responds, and logs no console or page error
   (`runSmoke`). One message is not an error of the app: WebKit reports a fetch that the page's
   own navigation stopped as `Fetch API cannot load <url> due to access control checks.` The
   smoke check dismisses that message only when it was raised while the page was leaving for
   another document, or when Playwright saw the request for that URL cancelled. The same message
   for a fetch refused at any other time, such as a real CORS failure, still fails the check;
   next-app's full suite proves that in WebKit.

   An app that wires itself only after the page's load event declares `smoke.readySelector` in
   its `expectations.json` and matches it once it is wired: `cli-requirejs-amd`, whose modules
   require.js loads after `load`, sets `<body data-app-ready>` once its click handler is
   attached. After every navigation the smoke check waits for that selector before it checks or
   clicks anything, and fails if the served HTML already matches it.
4. For a fixture with a baseline build, its scenarios behave the same in both builds.

## Writing a scenario

A scenario runs the same Playwright steps against an unprotected baseline build and against the
protected build. Both runs must pass, and they must match:

- the protected build logs no console error or warning (hydration warnings included) and no page
  error that the baseline did not also log;
- both builds make the same requests: method, path with content hashes stripped, and status. A
  request the client aborted matches the same request with any outcome, because prefetch and
  stream aborts depend on timing. Favicon requests are left out;
- both builds load the same number of documents;
- the ARIA snapshot at every checkpoint is the same.

To write one:

1. Give the fixture a `baseline` in the registry. It builds the fixture with
   `AFTERPACK_build_autorun=false` into its own output directory, such as `dist-baseline` or
   `.next-baseline`, and serves it on its port plus 100. `receipts` names the baseline's
   counterpart of each receipt directory.
2. Write the steps as a function of `{ page, build, checkpoint, inPlace }`. Assert with Playwright's
   web-first assertions. The steps run once per build, so an assertion that fails names the build
   it failed in; a baseline failure means the fixture or the scenario is wrong.
3. `checkpoint(label, scope?)` waits for requests to settle, then records an ARIA snapshot of
   `scope` (the whole body by default). Keep request-time values, such as timestamps, out of it.
4. `inPlace(label, action)` sets a marker on `window`, runs `action`, and fails if the marker is
   gone: the navigation reloaded the page. `action` must wait for the new page state itself.
5. Declare the test in the fixture's spec:

```ts
import { expect, test } from "@playwright/test";
import { type ScenarioSteps, scenario } from "@e2e/helpers/scenario.js";

const journey: ScenarioSteps = async ({ page, checkpoint, inPlace }) => {
  await page.goto("/");
  await inPlace("the Notes link", async () => {
    await page.getByRole("link", { name: "Notes" }).click();
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible();
  });
  await checkpoint("notes");
};

test("the notes journey matches the baseline", { tag: "@scenario" }, scenario(journey));
```

Each test attaches both recordings (`baseline.json`, `protected.json`) to the report.
`vite-react.spec.ts` also shows the parity check failing on a protected bundle altered to log an
error, make an extra request and render extra text. Use `recordScenario` and `parityProblems` the
same way to check a new comparison rule.

## Engine candidates

`.github/workflows/e2e-candidate.yml` tests an unreleased `@afterpack/core`: the full lane in four
shards and three browsers, and the preset lane. It is triggered by a `repository_dispatch` of type
`e2e-candidate` or by hand:

```bash
gh api repos/afterpack-dev/afterpack/dispatches -f event_type=e2e-candidate \
  -f 'client_payload[version]=0.2.2-rc.202610011200' -f 'client_payload[id]=<caller run id>'
```

The run is named `E2E candidate <version> (<id>)`, so the caller can find it and wait for it. Every
job installs the workspace through `.github/actions/candidate-workspace`, which reads
`ENGINE_REGISTRY` and `ENGINE_REGISTRY_TOKEN` from the job's environment (`npm`). It writes them to
an npmrc under `RUNNER_TEMP`, sets `pnpm.overrides["@afterpack/core"]` to the candidate, installs
the workspace with `--ignore-scripts`, and deletes the npmrc. The dependencies' install scripts run
in the next step, which never sees the token. It then checks that every package resolved the
candidate and builds. The workflow never runs on a pull request. No cache it writes and no artifact
it uploads contains the candidate.

With a key, the candidate only sends the bundle; the API runs its own Pro engine. So the Pro lane,
`.github/workflows/e2e-pro.yml`, runs later, once the API serves the Pro engine built from the
candidate's commit:

```bash
gh api repos/afterpack-dev/afterpack/dispatches -f event_type=e2e-pro \
  -f 'client_payload[version]=0.2.2-rc.202610011200' -f 'client_payload[sha]=<engine commit>' \
  -f 'client_payload[id]=<caller run id>'
```

The run is named `E2E Pro <version> (<id>)`. Its one job runs in the `staging-pro` environment,
which must allow only the default branch and holds `AFTERPACK_KEY`, `ENGINE_REGISTRY`,
`ENGINE_REGISTRY_TOKEN` and the variable `AFTERPACK_API_URL`. `scripts/served-engine.mjs` first
reads the API's `/v1/version` and fails unless it reports a clean engine built from `sha` at the
candidate's release. The job then installs the candidate the same way and passes `AFTERPACK_KEY`,
`AFTERPACK_API_URL` and `AFTERPACK_E2E_ENGINE_VERSION` to its build-and-test step alone.

`vite-react` enables directives only when `AFTERPACK_KEY` is set: its Counter's `preset=hard`
region raises protection, which the Free engine refuses to build. `next-app`'s Counter carries a
`preset=minify` region, which lowers protection and which every engine applies, so every lane
captures and applies a region on both Next legs.
