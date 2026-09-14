# AfterPack Protection Map

An IDE-like heatmap viewer that turns a `ProtectionMapData` JSON document (schema v4, the
"reversal-class" layer) into a single self-contained HTML file: your **original source code**,
washed per token by how heavily AfterPack protected it, with a reversal-class card, collapsed
lineage, weak-spot, and cost detail on click.

**This is a dev-only local artifact. It embeds your original source code and surviving literal
samples. Never ship it, never publish it, never commit it to a public repo.** Add
`*.protectionMap.html` / `protectionMap.html` to `.gitignore` in any project that generates one —
the AfterPack plugins add these entries for you the first time they run.

Frontend only — no engine dependency, no build step, no gates. Two files do all the work:

- `template.html` — the self-contained viewer shell (inline CSS + inline JS, zero external
  requests, works opened straight from disk).
- `render.mjs` — a small Node script that embeds a `ProtectionMapData` JSON document into the
  template and writes the final HTML.

## How to generate one

1. Run the engine with reporting enabled to get a `ProtectionMapData` JSON document. The v4
   "reversal-class" shape (`regions[].reversalClass`/`score`/`tier`/`why`/`ceiling`,
   `spotlights[].reversalClass`, `aggregate.classSummary`) is emitted by `@afterpack/core`; the
   schema bump from v1 is additive, so every v1 field is still present unchanged.
2. Render it:

   ```bash
   node packages/protection-map/render.mjs path/to/your-report.json \
     packages/protection-map/template.html \
     path/to/output/protection-map.html
   ```

3. Open `protection-map.html` in any browser. No server, no network — it works from a `file://`
   URL.

`render.mjs` also caps each region's embedded `lineage[]` array to 20 entries (recording the true
original length as `region.lineageCapped` so the viewer can show an honest "+N more" note) — the
lineage of a whole-file region can run into the thousands of steps, and there is no reason to ship
all of them to the browser. The viewer then collapses *consecutive identical* lineage steps into
one row (`ScopeDeepen ×19`, combined entropy/size deltas) on top of that, so a capped-at-20 region
usually renders as 2–4 readable rows, not 20 near-duplicates.

### Multi-file readiness

The engine emits one `ProtectionMapData` document per run, and there is no standardized multi-file
merge shape yet. The viewer is built around a real, recursive VS-Code-style file
tree, though, so `render.mjs` always hands it `{ files: [...] }`: a single input document is
wrapped as a one-element array; a hypothetical future merger document that already has a top-level
`files[]` array is passed through untouched. This is an **invented, documented convention owned by
this viewer only** — not a claim about any engine-side schema. Today it renders one flat file row;
feeding it several documents with real `file.path` values will nest them into folders with no
further changes.

## The three "aha" moments

1. **The reversal class is the headline, not the transform log.** Every region leads with a
   labeled chip — *Preserved* / *Renamed & encoded* / *Flattened & fused* / *Destroyed & fused* —
   plus its `score` (0–100), `tier`, and the document's own `why`. The raw `lineage[]` ledger is
   secondary, shown collapsed below it. On the demo's hot IIFE region, 287 raw steps (`render.mjs`
   caps the embed at 20) collapse into 2 readable rows — `MaterializeAsConditionalSelection` once,
   `ScopeDeepen ×19` — instead of 20 near-identical lines.
2. **Under-protection spotlight, pinned precisely.** The demo's `DEBUG_BACKDOOR_TOKEN_do_not_ship`
   string literal **leaked** — it survived unprotected in the output (a `spotlights[]` entry,
   severity `leak`) — while the `SECRET_KEY` API-key literal a few lines above drained through 287
   transform steps fine. Note: a spotlight's `span` covers the whole enclosing statement
   (here, the entire `retry:` loop block), not just the leaked literal — the viewer searches for
   the exact `sample` text inside that span and narrows the red underline + ⚠ pin to just the
   literal itself, so the decoration doesn't imply the whole loop leaked. The right panel's "Weak
   spots" list is always visible, independent of what's selected, and jumps straight to each one.
3. **Pro ceiling, copy-pasteable.** Every non-preserved region carries a `ceiling` (the next
   reversal class reachable and the document's own `directive` text) and every spotlight carries a
   `proHint` — both render as a "Force-protect in Pro" box with a copy button. The demo's build
   only reaches *Renamed & encoded* (Free); the class-distribution panel and the reversal-class
   legend show *Flattened & fused* / *Destroyed & fused* as dashed "ceiling" chips, never as
   achieved — the viewer doesn't invent richer coloring than `aggregate.classSummary` supports.

## Design notes

- **Heat wash, not boxes.** Every token's background is a translucent, score-scaled wash — no
  box-shadow outlines, no per-token ink swap (alpha is capped low enough, see below, that the
  page's own text color stays legible painted straight on top). Adjacent characters that resolve
  to the *same* region are already merged into one DOM span upstream (the sweep-line fill below),
  so a same-color stretch of code is one element, not one span per character. A second, much
  fainter wash sits on the whole line underneath the per-token wash — a width-weighted average of
  every token's score on that line, diluted toward transparent by any uncovered/unprotected
  characters — the same "how hot is this line overall" cue a `heatColor(lineScore)` computation
  provides.
- **Palette.** Brand accent and the protection heat ramp are the **same sequential single-hue
  teal** (`#0e8f9d` light / `#2ec1cf` dark, pale→deep), read live off CSS custom properties (7
  hand-placed stops per theme, perceptually interpolated in OKLab) so the theme toggle and the
  ramp stay a single source of truth. The Cost lens is a separate sequential amber ramp. Reversal-
  class **chips** are a *categorical* palette, deliberately distinct from the sequential heat
  ramp: Preserved = neutral gray, Renamed & encoded = the brand teal (the class this build
  actually achieves), Flattened & fused = a deeper blue-teal, Destroyed & fused = a premium
  violet/gold accent — the latter two are Free/Pro *ceilings*, styled as dashed "ghost" chips
  everywhere they appear with a zero count. Leak/weak spotlights are red (`#e2707c` dark /
  `#ad3646` light) and never color-alone — every one ships an icon + text label + (for leaks) an
  underline, kept visually distinct from both ramps.
- **Contrast is verified, not assumed.** Token wash alpha is `0.16 + score/100 * 0.34`, capped at
  0.5 — chosen so that even the theoretical worst case (score 100, the ramp's brightest dark-theme
  stop, painted under dark theme's light body text) still contrasts at ≈4.7:1 against
  `--text-primary` (checked by hand against the WCAG contrast formula; see the `tokenAlpha` comment
  in `template.html`). The line-level wash is capped much lower (0.22) and was never close to the
  threshold.
- **The whole-file "machinery bucket," excluded on purpose.** Every `ProtectionMapData` document
  ships one region whose span covers the entire file (`nodeKind` like `Program`, `reversalClass`
  `"preserved"`, `score` `0`) — file-wide bookkeeping that doesn't map to any specific span. Because its span covers everything,
  *every* character in the file technically falls inside it — so it is hard-excluded from ever
  winning a paint/selection decision (detected by span-covers-file AND `reversalClass ===
  "preserved"` AND `score <= 0`, not span alone) and is painted as a flat, constant, near-neutral
  `--wash` instead of the score-scaled ramp. Clicking a token with no more specific region opens the
  "Not attributed" card, which states what the token lexically *is* and whether a recorded region
  edge stops just short of it; the bucket's own file-wide numbers ride on a flag on that card, so
  they can never be mistaken for the selected token's. The class-distribution panel subtracts this bucket from the displayed
  "preserved" count too, with a footnote, so a build with zero *real* preserved code doesn't read
  as having one.
- **Fill rule: deepest region wins.** `color_at(char) = the SMALLEST-WIDTH (most specific)
  non-machinery region whose span contains it`, tie-broken by higher score. This replaced v1's
  "max entropy wins" rule: since a region's identity *is* its reversal class now, the most
  specific region covering a token is always the right one both to paint *and* to select on click
  — a click can never resolve to a coarse ancestor region anymore, which was v1's reported bug
  (clicking a token inside a large/whole-file region used to highlight "everything"). Implemented
  as an event sweep over region/spotlight boundaries (not a per-character scan), `O(regions log
  regions)`. Region/spotlight spans are UTF-16 code-unit offsets from schema v4 on (`spanUnits:
  "utf16"`, the same unit JS already indexes strings in) — a document that predates v4 carries no
  `spanUnits` and its spans are UTF-8 byte offsets instead, so the viewer keeps
  a byte→JS-string-index conversion path for that case, painting and slicing correctly either way
  on non-ASCII source (the demo's own source has one em dash).
- **"Highlight same class" — a deliberate, labeled mode.** A checkbox in the code toolbar (enabled
  once a region is selected) tints every region sharing the selected region's `reversalClass` with
  a subtle ring and dims everything else. The count rides in a permanently-reserved slot next to
  the toggle (turning the mode on only makes it *visible*, so it can never shove the neighbouring
  controls sideways) and the class it names is in that slot's tooltip. Orthogonal to the heat wash
  and off by default — an explicit opt-in overlay, not a change to the default reading of the map.
- **Layout.** Three-pane IDE shell, themed after VS Code **Dark Modern / Light Modern** (the
  neutrals, borders and the four syntax hues are the editor's; every *background* in the code pane
  still belongs to the protection layer, and the heat ramp's ends are tuned so body text keeps
  >= 4.5:1 over the hottest wash in both themes). Left rail: recursive file tree with **sticky
  parent folders** (a file's whole ancestry stays pinned while you scroll), an `All / App / Vendor /
  Weak / Marked` filter, and a weak-spot badge + `@` marker per row. The tree opens **collapsed**
  except the chain down to the file that is showing — a real build carries hundreds of files, and a
  fully-expanded tree buries the one you came for. Folders badge the weak spots in their whole
  subtree, so a closed folder still admits what is inside it; `Weak` and `Marked` are short lists of
  hits and open every folder while they are on. Center: a two-row sticky header (path +
  copy button + source origin, then the pane's own toggles) over a line-numbered code pane with its
  own horizontal scroll — the page itself never scrolls sideways. Right rail: a fixed six-row
  per-file band, then the **Inspector** and **Weak spots** sections, both **collapsed by default**.
  Each is one header row that already states what it holds — `Inspector · no selection` or the live
  selection's identity, `Weak spots (N)` with N always visible — so the rail reserves no height for
  content nobody asked for, and the sections stack from the top rather than splitting the pane in
  half. Selecting a token opens the Inspector without remembering that it did; only a deliberate
  toggle is stored (`inspectorSectionCollapsed` / `weakspotsCollapsed` in the prefs blob, distinct
  from `inspectorCollapsed`, which hides the whole rail). Panes stack vertically under ~980px.
  Every painted token is a real keyboard-focusable, `role="button"` element, and
  `prefers-reduced-motion: reduce` disables the (already minimal) transitions.
- **Weak spots and leaks are two names, not one.** A *weak spot* is one `spotlights[]` entry — a
  readable literal this build left in the output. That is what the engine counts as
  `aggregate.weakRegions` (its own name for the same number) and what the dashboard's "Weak spots"
  tile sums build-wide. A *leak* is the subset whose severity is `leak`; the rest are residual
  property names the engine has to keep literal. The viewer used to print the build-wide LEAK total
  in the tree header under the word "leaks" while the inspector printed the open file's WEAK-SPOT
  count under the words "Weak spots" — two quantities at two scopes sharing neither name nor number.
  Now every surface says *weak spots*, the leak subset rides in the tooltip (and in the badge's red
  vs amber + a `⚠` glyph, never colour alone), and the scope is stated wherever the two can differ:
  the tree header is build-wide, everything else is the open file.

- **Directive regions are a tint, not an outline.** A resolved `/* @afterpack … */` marker paints a
  continuous background tint in the marker's own reversal-class hue (skip → preserved, hardened →
  flattened, destroy → destroyed, `K=V` → brand). It used to be a per-token inset ring, which the
  run builder then cut into one box per renamed token, extracted name, weak spot and line — the
  marked block became unreadable. The tint is composed in JS beside the heat wash (it rides as the
  top `background-image` layer, because the wash owns the token's inline `background` shorthand),
  and the hue is mixed 60% toward the page ground in OKLab first: the wash's alpha cap leaves only
  ~0.2 of contrast headroom on the hottest token, and a raw class hue spends all of it. Ground-mixed
  at alpha 0.42, body text over the hottest wash measures 4.58–4.78:1 dark and 6.9–7.4:1 light —
  at or above the un-tinted baseline in every kind and both themes.

- **A directive's highlight is clamped to its own `end` marker.** `aggregate.directives[].span` is
  the region the ENGINE resolved for a marker, back-coloured through the build source map — not the
  marker-to-marker source span — so it legitimately ends *past* the closing `/* @afterpack end */`,
  and the gutter bar used to paint that overrun faithfully. The viewer now clamps each directive to
  the line of its own depth-matched `end` marker before boundaries and runs are built, so the gutter,
  the run splitting and the inspector all agree. It only ever pulls the end IN, never out, and only
  treats keywords the file actually records as markers.

- **TypeScript type positions are inert**, like comments, whitespace and punctuation. The compiler
  erases them before AfterPack ever sees the file, so the map can never have anything to say about
  them: they keep their syntax colour and lose `.tok`, `tabindex`, `title` and the hover wash. This
  is a token-level scanner, not a TypeScript parser — it re-splits merged punctuation, walks the atom
  stream with a bracket-frame stack, caches per file, runs only on typed files, and reuses the same
  grammar table that drives the header's JS/TS indicator. Inert: `interface`/`type`/`declare`
  statements and their bodies, `import type`/`export type`, annotations from `:` to their terminator,
  and call-site type arguments. Deliberately still selectable, because each needs real parsing or is
  genuinely ambiguous: `as`/`satisfies` casts, generic type-PARAMETER lists, inline
  `import { type Foo }`, and `:` in object literals, ternaries, labels and `case`. **Conservative on
  purpose** — leaving a type selectable is a far smaller sin than making real code inert, which is
  not hypothetical: classifying every paren frame as a parameter list made JSX text inside
  `return (…)` inert, so paren frames are now classified by a precomputed bracket match plus an
  arrow/function/method test.

- **Deep links.** The viewer reads a URL fragment on load and on `hashchange`, and mirrors the
  current view back into it with `replaceState` (no history entries, no `hashchange` re-entry):
  `#file=<path>&filter=<all|app|vendor|weak|marked>`. `weak-spots` / `weakspots` / `leaks` alias to
  `weak` and `directives` to `marked`. A path resolves exactly, then case-insensitively, then by an
  *unambiguous* trailing-segment or basename match — ambiguity is a miss, never a guess. Everything
  degrades: a path this map does not carry, an unknown facet, or a facet that would select nothing
  falls back to the default view and prints the reason in the rail rather than landing the reader
  somewhere unexplained. A named file outranks a named facet.

  Three more fragment keys FORCE a start state for an embedder, outranking both the remembered
  preference and the OS, and **none of the three is ever remembered** — forcing a view is not the
  reader choosing one, and writing it back would re-theme every other map on the origin:
  `#rail=<collapsed|open>`, `#theme=<dark|light>`, and `#weakspots=<collapsed|open|hidden>`.
  The weak-spots key takes three values rather than two because `hidden` is not a louder
  `collapsed`: `collapsed` (the default) leaves the header and its count, `open` starts the list
  expanded, and `hidden` does not render the section at all — what a docs or marketing embed wants,
  where a list of unrenameable property names (`push`, `length`) reads as a verdict it never
  earned, and the count alone still does out of context. `closed`/`off` alias to `collapsed`,
  `none` to `hidden`, `expanded`/`shown`/`on` to `open`; an unrecognised value is ignored rather
  than guessed at. The reader still owns the controls inside a framed map, and a deliberate click
  there IS remembered.

- **The inspector has ONE shape.** Whatever you select — a region, a preserved span, a renamed
  identifier, a leak, an un-attributed token — the panel renders the same skeleton: an identity
  line, a score meter, a context line, exactly six fact rows and one action row, followed by a
  collapsed transform chain. (With *nothing* selected it renders one hint line and no card at all:
  the file-aggregate card it used to print there was a second copy of the "This file" band directly
  above it, and printing the same six numbers twice is what the constant height was costing.)
  The row count never varies and no cell wraps, so
  the panel's height is a constant (measured: 288 px across 288 selections spanning six kinds and
  three rail widths). No explanation is printed in it: every sentence, caveat and warning lives in
  `INSP_COPY` (or in the document's own `why` / `UNLIT_VERDICT` strings) and is rendered as the
  `data-tip` of the row, chip or flag it belongs to. A row that carries one shows a dotted key.
- **Honesty.** `sizeDeltaEst` is an *estimate* of added output bytes, not
  a byte-exact count, and the perf numbers (`decodeOps`/`callFrames`) are a **per-site static** op
  count, not amortized over loop iterations or repeated calls — both caveats are a persistent note
  in the right panel. The class-distribution panel and reversal-class legend only ever show
  *Flattened & fused* / *Destroyed & fused* as dashed ceiling chips unless `aggregate.classSummary`
  actually reports a nonzero count for them — the viewer never implies a build reached further than
  `classSummary.maxClassReached` says it did.

## Schema

The v4 "reversal-class" JSON shape (`regions[].reversalClass`/`score`/`tier`/`why`/`ceiling`,
`spotlights[].reversalClass`, `aggregate.classSummary`) is emitted by `@afterpack/core` at
`SCHEMA_VERSION = 4`. The viewer makes no assumptions beyond that JSON shape; it does not require the
engine, a specific preset, or network access to render. Notable invariants worth knowing when
reading a document: `tier` is `null` if and only if `reversalClass === "preserved"`; a spotlight's
own `reversalClass` is always `"preserved"` (a spotlight *is* a surviving readable
literal, by definition); `flattened-fused`/`destroyed-fused` are documented enum values the viewer
renders as dashed ceiling chips rather than achieved classes whenever `aggregate.classSummary`
reports a zero count for them.

## Feedback

Questions and proposals: https://github.com/afterpack-dev/afterpack/discussions · Bugs: https://github.com/afterpack-dev/afterpack/issues
