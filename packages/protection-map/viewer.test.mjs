import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadViewer, makeStorage, readPrefs } from "./viewer-harness.mjs";

const MACHINERY_NOTE =
  "Engine-internal / un-attributable spans (whole-program scaffolding and any " +
  "bundle position the input source map does not cover). Listed for accounting; " +
  "not attributed to your original source.";

function region(over) {
  return {
    span: [0, 4],
    nodeKind: "Lowered",
    reversalClass: "renamed-encoded",
    score: 53,
    tier: "free",
    why: "why",
    entropyRaw: 6,
    transformCount: 1,
    sizeDeltaEst: 12,
    perf: { costClass: "none", decodeOps: 0, callFrames: 0 },
    lineage: [],
    annotations: [],
    band: "inflatable",
    outputSpan: null,
    ...over,
  };
}

function docWithMachineryAsLastFile() {
  const src = "const alpha = 1;\nconst beta = alpha + 2;\n";
  return {
    schemaVersion: 5,
    spanUnits: "utf16",
    engine: { version: "9.9.9", backend: "IrAuthoritative", seed: 42, preset: "hard" },
    files: [
      {
        file: {
          path: "src/app.js",
          sourceOrigin: "original",
          vendor: false,
          originalSource: src,
          inputSize: src.length,
          outputSize: 80,
          outputSizeEstimated: false,
          inflationRatio: 1.9,
        },
        regions: [region({ span: [6, 11] }), region({ span: [23, 27], score: 71 })],
        spotlights: [],
        renamedSpans: [6, 11],
        extractedSpans: [23, 27, 1],
        aggregate: {
          totalTransforms: 2,
          weakRegions: 0,
          leakCount: 0,
          renamedCount: 1,
          extractedCount: 1,
        },
      },
      {
        file: {
          path: "(engine machinery — unattributable)",
          sourceOrigin: "machinery",
          vendor: false,
          originalSource: MACHINERY_NOTE,
          inputSize: 500000,
          outputSize: 960000,
          outputSizeEstimated: false,
          inflationRatio: 1.92,
        },
        regions: [
          region({
            span: [0, 500000],
            nodeKind: "Program",
            reversalClass: "preserved",
            score: 0,
            transformCount: 0,
            sizeDeltaEst: 4096,
          }),
          region({ span: [131072, 131400], score: 44 }),
        ],
        spotlights: [
          {
            span: [200000, 200040],
            severity: "leak",
            sample: "secret",
            mechanism: "m",
            disposition: "d",
          },
        ],
        renamedSpans: [300000, 300006],
        extractedSpans: [400000, 400008, 0],
        aggregate: {
          totalTransforms: 3,
          weakRegions: 1,
          leakCount: 1,
          renamedCount: 1,
          extractedCount: 1,
          directives: [{ keyword: "hardened", span: [450000, 450100], target: 90, floor: null }],
        },
      },
    ],
  };
}

test("A. every derived char offset stays inside its own source (utf16 path)", async () => {
  const v = await loadViewer(docWithMachineryAsLastFile());
  assert.equal(v.FILES.length, 2);
  for (const f of v.FILES) {
    const len = f.source.length;
    assert.equal(len, f.sourceLen);
    const lanes = [
      ["regions", f.regions],
      ["spotlights", f.spotlights],
      ["renamedRanges", f.renamedRanges],
      ["extractedRanges", f.extractedRanges],
      ["directives", f.directives],
    ];
    for (const [name, list] of lanes) {
      for (const r of list) {
        assert.ok(
          r.startChar >= 0 && r.startChar <= len,
          `${f.displayName} ${name} startChar ${r.startChar} outside [0,${len}]`,
        );
        assert.ok(
          r.endChar >= 0 && r.endChar <= len,
          `${f.displayName} ${name} endChar ${r.endChar} outside [0,${len}]`,
        );
      }
    }
    for (const run of f.mergedRuns) {
      assert.ok(run.end <= len, `${f.displayName} run end ${run.end} past ${len}`);
    }
    const c = f.coverage;
    assert.equal(
      c.protected + c.hidden + c.renamed + c.readable + c.plain,
      c.total,
      "buckets must sum to the file length",
    );
    for (const k of ["protected", "hidden", "renamed", "readable", "plain"]) {
      assert.ok(c[k] >= 0 && c[k] <= c.total, `coverage.${k}=${c[k]} outside [0,${c.total}]`);
    }
  }
  const app = v.FILES[0];
  assert.equal(
    JSON.stringify(app.regions.map((r) => [r.startChar, r.endChar])),
    "[[6,11],[23,27]]",
    "the in-range file is untouched by the clamp",
  );
  assert.equal(app.source.slice(6, 11), "alpha");
  const mach = v.FILES[1];
  assert.equal(mach.sourceLen, MACHINERY_NOTE.length);
  assert.ok(mach.machinery, "the whole-file Program baseline is still recognised as machinery");
  assert.equal(
    Math.max(...mach.regions.map((r) => r.endChar)),
    MACHINERY_NOTE.length,
    "bundle-wide region spans clamp onto the note's length rather than the bundle's",
  );
});

test("B. only the machinery entry carries a head note; your own files show none", async () => {
  const v = await loadViewer(docWithMachineryAsLastFile());
  const note = v.byId("head-note");

  v.updateSourceOriginNote(v.FILES[1]);
  assert.equal(v.sourceOriginOf(v.FILES[1]), "machinery");
  assert.equal(note.hidden, false);
  assert.equal(note.textContent, "AfterPack runtime (not your code)");
  assert.match(note.getAttribute("data-tip"), /Not one of your files/);

  v.updateSourceOriginNote(v.FILES[0]);
  assert.equal(note.hidden, true, "an original-source file needs no origin label");
  assert.equal(note.textContent, "");
  const ei = { doc: { file: { sourceOrigin: "engineInput" } } };
  v.updateSourceOriginNote(ei);
  assert.equal(note.hidden, true, "'source: engine-input' is gone");
  assert.doesNotMatch(note.textContent, /engine-input/);
});

test("C. buildByteStarts keeps a surrogate pair whole (legacy byte path)", async () => {
  const v = await loadViewer(docWithMachineryAsLastFile());
  const src = "const \u{1F600} = 1;";
  const starts = v.buildByteStarts(src);
  const toChar = v.makeByteToChar(src);

  assert.equal(src.codePointAt(6) > 0xffff, true, "the emoji at char 6 is outside the BMP");
  assert.equal(starts[6], 6, "the emoji's high surrogate starts at byte 6, same as char 6");
  assert.equal(starts[7], 10, "the low surrogate must carry the NEXT character's byte start");
  assert.equal(toChar(6), 6, "the pair's byte start must resolve to the HIGH surrogate");
  assert.equal(src.slice(toChar(6), toChar(10)), "\u{1F600}");

  const total = starts[src.length];
  for (let b = 0; b <= total; b++) {
    const c = toChar(b);
    const u = src.charCodeAt(c);
    assert.ok(
      !(u >= 0xdc00 && u <= 0xdfff),
      `byte ${b} resolved to char ${c}, a lone low surrogate`,
    );
  }
  for (let i = 0; i < starts.length - 1; i++)
    assert.ok(starts[i] <= starts[i + 1], `starts not monotonic at ${i}`);
  for (let b = 0; b < 6; b++) assert.equal(toChar(b), b, `ASCII byte ${b} maps to itself`);
});

test("D. cardUnlit says what the token is and why, with no location line and no padding rows", async () => {
  const v = await loadViewer(docWithMachineryAsLastFile());
  const file = v.FILES[0];
  const html = v.cardUnlit(file, { pos: 0, end: 5, type: "k" });
  const keys = [...html.matchAll(/<span class="k">([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(
    keys,
    ["What it is"],
    "one fact; the file-level percentages live in the This-file band",
  );
  assert.match(html, />keyword</);
  assert.match(html, /class="insp-line">A keyword such as if or return/);
  assert.ok(!/chars \d/.test(html), "no 'kind · chars N–M' location line");
  assert.ok(!html.includes("is-pad"), "no padding rows");
  assert.ok(!html.includes("insp-actions"), "no empty action strip");
  assert.ok(!html.includes("insp-chain"), "no transforms block on a card with no region");
});

function docWithTree() {
  const page = 'const title = "Sign in";\nexport default function Page() { return title; }\n';
  const auth =
    'const TOKEN = "let-me-in";\nexport function signIn() { return JSON.stringify({ TOKEN }); }\n';
  const keys = "/* @afterpack hardened */\nexport function derive(s) { return s * 31; }\n";
  const spot = (src, sample, severity) => ({
    span: [src.indexOf(sample), src.indexOf(sample) + sample.length],
    severity,
    mechanism: "ShortLiteral",
    disposition: severity === "leak" ? "Leak" : "PropertyNameResidual",
    sample,
    bytes: sample.length,
    reason: "r",
    proHint: "/* @afterpack extreme */",
    reversalClass: "preserved",
  });
  const entry = (path, source, spotlights, directives) => ({
    file: {
      path,
      sourceOrigin: "original",
      vendor: false,
      originalSource: source,
      inputSize: source.length,
      outputSize: 99,
      outputSizeEstimated: true,
      inflationRatio: 1.5,
    },
    regions: [
      region({ span: [0, source.length], reversalClass: "preserved", score: 0, tier: null }),
    ],
    spotlights,
    renamedSpans: [],
    extractedSpans: [],
    aggregate: {
      totalTransforms: 1,
      weakRegions: spotlights.length,
      leakCount: spotlights.filter((s) => s.severity === "leak").length,
      renamedCount: 0,
      extractedCount: 0,
      directives,
    },
  });
  return {
    schemaVersion: 5,
    spanUnits: "utf16",
    engine: { version: "9.9.9" },
    files: [
      entry("src/app/page.tsx", page, [], []),
      entry(
        "src/lib/auth.ts",
        auth,
        [spot(auth, '"let-me-in"', "leak"), spot(auth, "stringify", "propertyName")],
        [],
      ),
      entry(
        "src/lib/crypto/keys.ts",
        keys,
        [],
        [{ keyword: "hardened", span: [0, keys.length - 1], target: 90, floor: null }],
      ),
    ],
  };
}

test("E. the tree opens collapsed except the open file's ancestry", async () => {
  const v = await loadViewer(docWithTree());
  assert.equal(Object.keys(v.state.expandedFolders).sort().join(","), "src,src/app");
  assert.equal(Object.keys(v.ancestorExpansion(2)).sort().join(","), "src,src/lib,src/lib/crypto");
  const html = v.byId("file-tree").innerHTML;
  assert.match(html, /data-key="src"[^>]*aria-expanded="true"/);
  assert.match(html, /data-key="src\/lib"[^>]*aria-expanded="false"/);
  assert.ok(html.includes('data-file-idx="0"'), "the open file's row is rendered");
  assert.ok(!html.includes('data-file-idx="1"'), "a file under a closed folder is not");
  assert.match(
    html,
    /data-key="src\/lib"[\s\S]*?badge-weak/,
    "a closed folder still admits the weak spots it is hiding",
  );
});

test("F. a directive marks its MARKER TEXT and its gutter, not the region", async () => {
  const v = await loadViewer(docWithTree());
  v.state.activeFileIdx = 2;
  v.paintCode(v.FILES[2]);
  const html = v.byId("code-body").innerHTML;

  assert.match(
    html,
    /<span class="dir-kw">@afterpack<\/span>/,
    "the keyword alone carries the animated brand gradient",
  );
  assert.match(
    html,
    /<span class="dir-arg">[^<]*hardened[^<]*<\/span>/,
    "the parameter carries the brand colour without the animation",
  );

  const kwAt = html.indexOf('<span class="dir-kw">');
  assert.ok(kwAt > 0, "marker rendered");
  assert.ok(
    /\/\*\s*$/.test(html.slice(Math.max(0, kwAt - 12), kwAt)),
    "the comment opener sits outside the marker span, in ordinary comment colour",
  );

  const marked = [...html.matchAll(/<span [^>]*data-directive="hardened"[^>]*>/g)].map((m) => m[0]);
  assert.ok(marked.length > 0, "the marker's tokens still carry the directive");
  for (const tag of marked) {
    assert.ok(
      !/style="background:linear-gradient\(rgba\(/.test(tag),
      `a hundreds-of-lines-long hardened block must not paint every token with a region-wide tint: ${tag}`,
    );
    assert.ok(!/box-shadow/.test(tag), `a ring came back on ${tag}`);
  }

  assert.match(
    html,
    /class="code-line has-directive"/,
    "the controlled line's extent is still findable via its gutter marker",
  );
});

test("F2. a directive over a stretch with no covering region: inert punctuation, escaped title", async () => {
  const src = "/* @afterpack skip */\nconst a = 1; // trailing\n";
  const docWithDirectiveButNoRegion = {
    schemaVersion: 5,
    spanUnits: "utf16",
    engine: { version: "9.9.9", backend: "IrAuthoritative", seed: 1, preset: null },
    files: [
      {
        file: {
          path: "src/only.ts",
          sourceOrigin: "original",
          vendor: false,
          originalSource: src,
          inputSize: src.length,
          outputSize: 42,
          outputSizeEstimated: true,
          inflationRatio: 1,
        },
        regions: [],
        spotlights: [],
        renamedSpans: [],
        extractedSpans: [],
        aggregate: {
          totalTransforms: 0,
          weakRegions: 0,
          leakCount: 0,
          renamedCount: 0,
          extractedCount: 0,
          directives: [{ keyword: 'skip" onmouseover=x', span: [0, src.length], target: 0 }],
        },
      },
    ],
  };
  const v = await loadViewer(docWithDirectiveButNoRegion);
  v.paintCode(v.FILES[0]);
  const html = v.byId("code-body").innerHTML;

  assert.match(
    html,
    /data-directive="(skip|custom)"/,
    "the directive reaches the token; data-directive carries the resolved kind (custom for an unrecognised keyword), not the raw keyword text",
  );
  assert.ok(
    !/<span class="tok tok-unlit[^"]*"[^>]*>;<\/span>/.test(html),
    "a semicolon is not a selectable token",
  );
  assert.ok(!/<span [^>]*class="tok[^"]*sy-c/.test(html), "a comment is not a token");
  assert.ok(
    !/onmouseover=x/.test(html) || /&quot;/.test(html),
    "a keyword containing a quote is escaped in the title rather than closing the attribute early",
  );
});

test("G. weak spots are named consistently and the Weak facet selects them", async () => {
  const v = await loadViewer(docWithTree());
  assert.equal(v.FILES.map((f) => f.weakSpotCount).join(","), "0,2,0");
  assert.equal(v.FILES.map((f) => f.leakCount).join(","), "0,1,0");
  assert.ok(!v.isWeakFile(v.FILES[0]) && v.isWeakFile(v.FILES[1]));
  assert.ok(
    v.isMarkedFile(v.FILES[2]) && !v.isMarkedFile(v.FILES[1]),
    "marked (did a directive resolve here) is a different question than weak-spot and must not conflate with it",
  );
  assert.equal(
    v.byId("workspace-summary").textContent,
    "2 weak spots",
    "the tree header counts weak spots build-wide, under that name",
  );
  assert.match(v.byId("workspace-summary").getAttribute("data-tip"), /1 readable string/);
  assert.match(v.byId("workspace-summary").getAttribute("data-tip"), /1 readable property name/);
  const band = v.byId("file-summary-metrics").innerHTML;
  assert.ok(band.includes(">Weak spots<"), "the open file's band counts them under the same name");
  assert.ok(!/leaks?<\/span>/i.test(band), "the band never labels the count 'leaks'");
  v.setFileFilter("weak");
  const html = v.byId("file-tree").innerHTML;
  assert.ok(html.includes('data-file-idx="1"'), "the weak file is listed");
  assert.ok(!html.includes('data-file-idx="0"'), "a clean file is not");
});

test("H. deep links open a file/facet and degrade when they cannot", async () => {
  const hit = await loadViewer(docWithTree(), { hash: "#file=src/lib/auth.ts" });
  assert.equal(hit.state.activeFileIdx, 1);
  assert.equal(hit.byId("deeplink-note").hidden, true);
  assert.ok(hit.replaced.includes("#file=src/lib/auth.ts"));

  const facet = await loadViewer(docWithTree(), { hash: "#filter=weak" });
  assert.equal(facet.state.activeFileIdx, 1, "the weak facet opens a file that has one");
  assert.ok(facet.replaced.some((u) => u.includes("filter=weak")));

  const alias = await loadViewer(docWithTree(), {
    hash: "#filter=weak-spots&file=./src/lib/auth.ts",
  });
  assert.equal(alias.state.activeFileIdx, 1, "an alias and a leading './' resolve");
  assert.equal(alias.findFileIdxByPath("keys.ts"), 2, "a basename resolves");
  assert.equal(alias.findFileIdxByPath("src/lib"), -1, "an ambiguous path does not resolve");

  const miss = await loadViewer(docWithTree(), { hash: "#file=nope.ts&filter=bogus" });
  assert.equal(miss.state.activeFileIdx, 0, "falls back to the default file");
  assert.equal(miss.byId("deeplink-note").hidden, false);
  assert.match(miss.byId("deeplink-note").textContent, /unknown filter/);
  assert.match(miss.byId("deeplink-note").textContent, /not in this Protection Map/);
});

function v4DocWithPreRenameEngineHeader() {
  const src = "const a = 1;\n";
  return {
    schemaVersion: 4,
    spanUnits: "utf16",
    engine: {
      version: "0.0.10",
      backend: "IrAuthoritative",
      seed: 42,
      preset: "Hard",
      materialize: true,
      complexityTarget: 12,
    },
    files: [
      {
        file: {
          path: "src/only.ts",
          sourceOrigin: "original",
          vendor: false,
          originalSource: src,
          inputSize: src.length,
          outputSize: 42,
          outputSizeEstimated: true,
          inflationRatio: 1,
        },
        regions: [],
        spotlights: [],
        renamedSpans: [],
        extractedSpans: [],
        aggregate: { weakRegions: 0, directives: [] },
      },
    ],
  };
}

test("I. a stored v4 blob still renders, and its renamed complexity field degrades visibly", async () => {
  const { byId } = await loadViewer(v4DocWithPreRenameEngineHeader());
  const info = byId("engine-info").innerHTML;
  const row = (k) => new RegExp(`<dt[^>]*>${k}</dt><dd>([^<]*)</dd>`).exec(info)?.[1];
  assert.equal(row("Seed"), "42", "seed still renders");
  assert.equal(row("Engine version"), "0.0.10");
  assert.equal(
    row("Complexity target"),
    "—",
    "a field renamed since v4 reads as unknown, never as a fabricated value or a throw that costs the reader the whole map",
  );
  assert.equal(row("Preset"), "Hard", "a field still spelled the same renders in its old case");
  for (const gone of ["backend", "materialize", "source origin", "schema"]) {
    assert.ok(!info.includes(`>${gone}<`), `the internal "${gone}" row is gone`);
  }
  assert.equal(byId("build-cx").hidden, true, "no complexity chip without a known target");
});

test("J. both rail sections open collapsed, and a deliberate toggle persists", async () => {
  const v = await loadViewer(docWithTree());

  assert.equal(v.isSectionCollapsed("inspector-section"), true);
  assert.equal(v.isSectionCollapsed("weakspots-section"), true);
  assert.equal(v.byId("inspector-head").getAttribute("aria-expanded"), "false");
  assert.equal(v.byId("weakspots-head").getAttribute("aria-expanded"), "false");
  assert.deepEqual(
    readPrefs(v.storage),
    {},
    "restoring a default is not the reader choosing one: nothing is written back",
  );

  assert.equal(v.byId("inspector-count").textContent, "no selection");
  assert.match(v.byId("inspector").innerHTML, /inspector-empty/);
  assert.ok(
    !v.byId("inspector").innerHTML.includes("Avg entropy"),
    "the file-aggregate card must not render with an empty selection, duplicating the This-file band",
  );

  v.selectUnlit(0, "k", 5);
  assert.equal(v.isSectionCollapsed("inspector-section"), false, "a token click opens the section");
  assert.equal(v.byId("inspector-head").getAttribute("aria-expanded"), "true");
  assert.equal(v.byId("inspector-count").textContent, "nothing recorded");
  assert.deepEqual(
    readPrefs(v.storage),
    {},
    "the auto-open from a token click is not remembered; only a deliberate collapse would be",
  );

  v.toggleWeakSpotsSection();
  assert.equal(v.isSectionCollapsed("weakspots-section"), false);
  assert.deepEqual(
    readPrefs(v.storage),
    { weakspotsCollapsed: false },
    "a deliberate toggle is stored under a key of its own, not inspectorCollapsed (which means the whole rail is hidden)",
  );

  const again = await loadViewer(docWithTree(), { storage: v.storage });
  assert.equal(again.isSectionCollapsed("weakspots-section"), false, "the expand survived");
  assert.equal(again.isSectionCollapsed("inspector-section"), true, "the untouched one did not");

  again.toggleInspectorSection();
  assert.deepEqual(readPrefs(again.storage), {
    weakspotsCollapsed: false,
    inspectorSectionCollapsed: false,
  });
  assert.equal(
    "inspectorCollapsed" in readPrefs(again.storage),
    false,
    "the inspector section's own collapse never writes through the key that hides the entire rail",
  );
});

test("K. #weakspots= forces the section three ways and remembers none of them", async () => {
  const hidden = await loadViewer(docWithTree(), { hash: "#weakspots=hidden" });
  assert.ok(hidden.byId("rail-right").classList.contains("weakspots-hidden"));
  assert.deepEqual(readPrefs(hidden.storage), {});

  const open = await loadViewer(docWithTree(), { hash: "#weakspots=open" });
  assert.equal(open.isSectionCollapsed("weakspots-section"), false);
  assert.equal(open.byId("weakspots-head").getAttribute("aria-expanded"), "true");
  assert.ok(!open.byId("rail-right").classList.contains("weakspots-hidden"));
  assert.deepEqual(readPrefs(open.storage), {});

  const collapsed = await loadViewer(docWithTree(), { hash: "#weakspots=collapsed" });
  assert.equal(collapsed.isSectionCollapsed("weakspots-section"), true);
  assert.ok(!collapsed.byId("rail-right").classList.contains("weakspots-hidden"));

  const none = await loadViewer(docWithTree(), { hash: "#weakspots=none" });
  assert.ok(
    none.byId("rail-right").classList.contains("weakspots-hidden"),
    "the 'none' alias resolves",
  );
  const bogus = await loadViewer(docWithTree(), { hash: "#weakspots=sideways" });
  assert.equal(
    bogus.isSectionCollapsed("weakspots-section"),
    true,
    "an unknown value is ignored rather than guessed at, leaving the stored preference (here: none, so the default) in charge",
  );
  assert.ok(!bogus.byId("rail-right").classList.contains("weakspots-hidden"));

  const storedOpen = makeStorage({
    "afterpack-protmap-prefs": JSON.stringify({ weakspotsCollapsed: false }),
  });
  const forcedShut = await loadViewer(docWithTree(), {
    hash: "#weakspots=collapsed",
    storage: storedOpen,
  });
  assert.equal(
    forcedShut.isSectionCollapsed("weakspots-section"),
    true,
    "the hash outranks a stored open choice",
  );
  assert.deepEqual(
    readPrefs(storedOpen),
    { weakspotsCollapsed: false },
    "the stored choice is not overwritten",
  );

  const storedShut = makeStorage({
    "afterpack-protmap-prefs": JSON.stringify({ weakspotsCollapsed: true }),
  });
  const forcedOpen = await loadViewer(docWithTree(), {
    hash: "#weakspots=open",
    storage: storedShut,
  });
  assert.equal(
    forcedOpen.isSectionCollapsed("weakspots-section"),
    false,
    "the hash outranks a stored shut choice too",
  );
  assert.deepEqual(
    readPrefs(storedShut),
    { weakspotsCollapsed: true },
    "the stored choice is not overwritten",
  );
});

test("L. the weak-spots header states its count, at 0 and at N", async () => {
  const clean = await loadViewer(docWithTree());
  assert.equal(
    clean.byId("weakspots-title").textContent,
    "Weak spots (0)",
    "the always-visible header states its count even when it is 0",
  );
  assert.ok(clean.byId("weakspots-section").classList.contains("is-empty"));
  assert.match(clean.byId("weakspots-list").innerHTML, /None in this file\./);
  assert.ok(clean.byId("rail-right").classList.contains("weakspots-quiet"));

  const weak = await loadViewer(docWithTree(), { hash: "#file=src/lib/auth.ts" });
  assert.equal(weak.state.activeFileIdx, 1);
  assert.equal(weak.byId("weakspots-title").textContent, "Weak spots (2)");
  assert.equal(weak.isSectionCollapsed("weakspots-section"), true, "still collapsed by default");
  assert.ok(!weak.byId("weakspots-section").classList.contains("is-empty"));
  assert.equal(
    weak.byId("weakspots-list").innerHTML.match(/class="weakspot"/g).length,
    2,
    "collapsed hides the body, not the count: the rows are still rendered underneath",
  );

  weak.renderWeakSpots(weak.FILES[0]);
  assert.equal(
    weak.byId("weakspots-title").textContent,
    "Weak spots (0)",
    "switching to a clean file re-states the count rather than leaving a stale N",
  );

  assert.equal(
    weak.inspectorSummary(weak.FILES[1], { spotlightIdx: 0 }),
    'weak spot · "let-me-in"',
    "the Inspector's header carries the selection's identity, not a fake count",
  );
  assert.equal(weak.inspectorSummary(weak.FILES[1], { regionIdx: 0 }), "Preserved");
  assert.equal(weak.inspectorSummary(weak.FILES[1], null), "no selection");
});

const CX_SRC = "const alpha = 1;\nconst beta = alpha + 2;\nlet gamma = 3;\n";

function docWithComplexityLane({ lane = true } = {}) {
  const at = (text, from = 0) => {
    const i = CX_SRC.indexOf(text, from);
    return [i, i + text.length];
  };
  const alpha = at("alpha");
  const one = at("1");
  const beta = at("beta");
  const alpha2 = at("alpha", beta[1]);
  const rhs = at("= alpha + 2");
  const gamma = at("gamma");
  const three = at("3");
  return {
    schemaVersion: 5,
    spanUnits: "utf16",
    engine: { version: "9.9.9", seed: 7, preset: "light", complexity: 5 },
    files: [
      {
        file: {
          path: "src/app.js",
          sourceOrigin: "original",
          vendor: false,
          originalSource: CX_SRC,
          inputSize: CX_SRC.length,
          outputSize: 120,
          outputSizeEstimated: false,
          inflationRatio: 2.2,
        },
        regions: [
          region({ span: alpha, score: 53 }),
          region({ span: beta, score: 71, reversalClass: "flattened-fused" }),
          region({ span: gamma, score: 20 }),
          region({
            span: three,
            reversalClass: "preserved",
            preservedReason: "position-blocked",
            score: 0,
            transformCount: 0,
          }),
        ],
        spotlights: [],
        renamedSpans: [],
        extractedSpans: [],
        ...(lane
          ? {
              complexitySpans: [...alpha, 5, ...one, 3, ...beta, 12, ...alpha2, 8, ...rhs, 6],
            }
          : {}),
        aggregate: { weakRegions: 0, leakCount: 0, renamedCount: 0, extractedCount: 0 },
      },
      {
        file: {
          path: "(engine machinery — unattributable)",
          sourceOrigin: "machinery",
          vendor: false,
          originalSource: MACHINERY_NOTE,
          inputSize: 10,
          outputSize: 10,
          outputSizeEstimated: false,
          inflationRatio: 1,
        },
        regions: [],
        spotlights: [],
        ...(lane ? { complexitySpans: [0, 10, 40] } : {}),
        aggregate: { weakRegions: 0, leakCount: 0 },
      },
    ],
  };
}

function runAt(file, text, from = 0) {
  const pos = file.source.indexOf(text, from);
  return file.mergedRuns.find((r) => r.start <= pos && r.end > pos);
}

test("M. the complexity bands: grey at 0, green under 4, yellow 4 to 7, red 7 to 10, dark red over 10", async () => {
  const v = await loadViewer(docWithComplexityLane());
  const cases = [
    [0, "none"],
    [0.5, "low"],
    [3.9, "low"],
    [4, "mid"],
    [5, "mid"],
    [6.99, "mid"],
    [7, "high"],
    [10, "high"],
    [10.01, "max"],
    [12, "max"],
    [25, "max"],
  ];
  for (const [c, band] of cases) assert.equal(v.complexityBand(c), band, `complexity ${c}`);
  assert.equal(v.complexityBand(null), null, "no value, no band");
  assert.equal(v.complexityBand(Number.NaN), null);
});

test("M2. with a per-token complexity lane, each token paints by its own value, innermost wins", async () => {
  const v = await loadViewer(docWithComplexityLane());
  const app = v.FILES[0];
  const band = (text, from) => {
    const run = runAt(app, text, from);
    return v.runPaint(run, run.regionIdx == null ? null : app.regions[run.regionIdx]).band;
  };
  assert.equal(runAt(app, "alpha").cx, 5);
  assert.equal(band("alpha"), "mid", "5 is yellow");
  assert.equal(band("1"), "low", "3 is green, even with no region over it");
  assert.equal(band("beta"), "max", "12 is dark red");
  const second = app.source.indexOf("alpha", app.source.indexOf("beta"));
  assert.equal(runAt(app, "alpha", second).cx, 8, "the inner token beats the enclosing expression");
  assert.equal(band("alpha", second), "high");
  assert.equal(
    runAt(app, "+", second).cx,
    6,
    "the operator takes its enclosing expression's value",
  );
  assert.equal(
    band("gamma"),
    "none",
    "a region with no recorded value is grey, not a wash of its own",
  );
  assert.equal(band("3"), "readable", "left-readable code is grey, never a complexity color");

  v.paintCode(app);
  const html = v.byId("code-body").innerHTML;
  for (const cls of ["cx-low", "cx-mid", "cx-high", "cx-max", "cx-none", "tok-preserved"]) {
    assert.ok(html.includes(cls), `the pane paints ${cls}`);
  }
  assert.ok(!html.includes("cx-protected"), "no region-level wash competes with the heat scale");
  assert.ok(!/style="background:/.test(html), "colors come from theme tokens, not inline styles");
  assert.match(html, /data-cx="12"[^>]*title="Complexity 12 · Flattened &amp; fused"/);

  assert.equal(app.cxCount, 5);
  assert.equal(app.cxAvg, 34 / 5, "the file average is the mean over its tokens");
  assert.equal(v.BUILD_CX.hasLane, true);
  assert.equal(v.BUILD_CX.avg, 34 / 5, "the build average leaves the AfterPack runtime entry out");
});

const HEAT_SRC = 'const API = "x";\nfunction f(key) {\n  return key + 1;\n}\n';

function docWithRealLaneShapes() {
  const at = (text, from = 0) => {
    const i = HEAT_SRC.indexOf(text, from);
    return [i, i + text.length];
  };
  const fn = [HEAT_SRC.indexOf("function"), HEAT_SRC.lastIndexOf("}") + 1];
  const param = at("key");
  const use = at("key", param[1]);
  return {
    schemaVersion: 5,
    spanUnits: "utf16",
    engine: { version: "0.1.1", seed: 7, preset: "medium", complexity: 7 },
    files: [
      {
        file: {
          path: "src/app.js",
          sourceOrigin: "original",
          vendor: false,
          originalSource: HEAT_SRC,
          inputSize: HEAT_SRC.length,
          outputSize: 400,
          outputSizeEstimated: false,
          inflationRatio: 8,
        },
        regions: [
          region({
            span: [0, HEAT_SRC.indexOf(";") + 1],
            reversalClass: "flattened-fused",
            score: 90,
          }),
        ],
        spotlights: [],
        renamedSpans: [at("API"), param, use],
        extractedSpans: [],
        complexitySpans: [
          ...at('"x"'),
          10,
          ...fn,
          0,
          ...use,
          10,
          ...at("key + 1"),
          10,
          ...at("1"),
          5,
        ],
        aggregate: { weakRegions: 0, leakCount: 0, renamedCount: 3, extractedCount: 0 },
      },
    ],
  };
}

test("M2b. with a lane, only the heat scale colors code: zero and unrecorded are grey, renamed names get an underline", async () => {
  const v = await loadViewer(docWithRealLaneShapes());
  const app = v.FILES[0];
  const paintOf = (text, from) => {
    const run = runAt(app, text, from);
    return v.runPaint(run, run.regionIdx == null ? null : app.regions[run.regionIdx]);
  };
  assert.equal(runAt(app, "const").cx, null);
  assert.equal(paintOf("const").band, "none", "a region with no lane value is grey, not indigo");
  assert.equal(paintOf("function").band, "none", "complexity 0 is grey, not green");
  assert.equal(paintOf("key").band, "none");
  assert.equal(paintOf('"x"').band, "high");
  assert.equal(paintOf("key", HEAT_SRC.indexOf("return")).band, "high");
  assert.equal(paintOf("1", HEAT_SRC.indexOf("return")).band, "mid");

  v.paintCode(app);
  const html = v.byId("code-body").innerHTML;
  for (const gone of ["cx-protected", "cx-names", "cx-low"]) {
    assert.ok(!html.includes(gone), `no ${gone} wash`);
  }
  assert.match(
    html,
    /class="tok cx-none tok-named tok-hot"[^>]*title="Complexity not recorded · Flattened &amp; fused · Renamed">API</,
  );
  assert.match(
    html,
    /class="tok cx-none tok-named tok-hot"[^>]*title="Complexity 0 · Renamed">key</,
  );
  assert.equal(
    (html.match(/tok-named/g) || []).length,
    2,
    "a renamed name with its own complexity color carries no underline",
  );

  const heat = app.mergedRuns.filter((r) => r.cx > 0).reduce((n, r) => n + (r.end - r.start), 0);
  assert.equal(app.coverage.protected, heat, "Protected counts the code the heat scale colors");

  const legend = v.byId("cx-legend").innerHTML;
  assert.ok(legend.includes("No complexity added"));
  assert.ok(legend.includes("Name hidden, nothing more"));
  assert.ok(!legend.includes("cx-protected") && !legend.includes("cx-names"));
  assert.match(
    v.byId("file-summary-metrics").innerHTML,
    /<span class="k">Protected<\/span><span class="v">/,
  );
});

test("M3. the header, band, legend and inspector show complexity in --complexity units", async () => {
  const v = await loadViewer(docWithComplexityLane());
  const chip = v.byId("build-cx");
  assert.equal(chip.hidden, false);
  assert.match(chip.innerHTML, /Complexity <span class="tag-em">6\.8<\/span> · target 5/);
  assert.equal(chip.getAttribute("data-doc"), "complexity");

  const band = v.byId("file-summary-metrics").innerHTML;
  assert.match(
    band,
    /<span class="k">Complexity<\/span><span class="v"><span class="cx-dot" data-band="mid"[^>]*><\/span>6\.8</,
  );
  for (const gone of ["Max class", "Attributed", ">Transforms<", ">Extracted<", ">Renamed<"]) {
    assert.ok(!band.includes(gone), `"${gone}" is gone from the This-file band`);
  }

  const legend = v.byId("cx-legend").innerHTML;
  for (const label of ["under 4", "4 to 7", "7 to 10", "over 10", "Left readable"]) {
    assert.ok(legend.includes(label), `the legend names "${label}"`);
  }
  assert.match(v.byId("cx-legend-note").innerHTML, /Hotter means more complex/);

  const app = v.FILES[0];
  const betaRun = runAt(app, "beta");
  v.state.selection = { regionIdx: betaRun.regionIdx, spotlightIdx: null, cx: betaRun.cx };
  v.renderInspector();
  const insp = v.byId("inspector").innerHTML;
  assert.match(insp, /<b>12<\/b><small>complexity<\/small>/);
  assert.match(insp, /data-band="max"/);
  assert.match(insp, /class="meter-tick" style="left:/, "the meter marks the build target");
  assert.ok(!insp.includes("/100"), "no score out of 100");
  assert.equal(v.inspectorSummary(app, v.state.selection), "Flattened & fused · complexity 12");
});

test("M4. without the lane, the viewer shows the build target and invents no per-token number", async () => {
  const v = await loadViewer(docWithComplexityLane({ lane: false }));
  assert.equal(v.BUILD_CX.hasLane, false);
  const app = v.FILES[0];
  assert.equal(app.cxAvg, null);
  assert.ok(app.mergedRuns.every((r) => r.cx == null));

  v.paintCode(app);
  const html = v.byId("code-body").innerHTML;
  for (const cls of ["cx-low", "cx-mid", "cx-high", "cx-max"]) {
    assert.ok(!html.includes(cls), `no ${cls} band without per-token data`);
  }
  assert.ok(html.includes("cx-protected"), "protected code shares one neutral color");
  assert.ok(html.includes("tok-preserved"));

  assert.match(
    v.byId("build-cx").innerHTML,
    /Complexity target <span class="tag-em">5<\/span> · light/,
  );
  const band = v.byId("file-summary-metrics").innerHTML;
  assert.match(band, /<span class="k">Complexity target<\/span><span class="v">5</);
  assert.match(v.byId("cx-legend-note").innerHTML, /doesn't record complexity per token/);
  assert.ok(!v.byId("cx-legend").innerHTML.includes("over 10"), "no band scale to misread");

  v.state.selection = { regionIdx: 1, spotlightIdx: null, cx: null };
  v.renderInspector();
  const insp = v.byId("inspector").innerHTML;
  assert.ok(!insp.includes("<small>complexity</small>"), "no per-token number");
  assert.match(insp, /<span class="k">Complexity target<\/span><span class="v">5</);
});

function regionWithChain() {
  const step = (transform, category, phase, credit, sizeDeltaEst = 10) => ({
    transform,
    category,
    phase,
    entropyGain: 5,
    credit,
    sizeDeltaEst,
    label: null,
  });
  return region({
    span: [6, 11],
    score: 93,
    reversalClass: "flattened-fused",
    ceiling: { class: "destroyed-fused", directive: "preset=extreme" },
    transformCount: 7,
    lineage: [
      step("LowerClass", "Structural", "Parse", 0, 0),
      step("CommaSequenceWrapVariant", "Structural", "Inflate", 9),
      step("CommaSequenceWrapVariant", "Structural", "Inflate", 9),
      step("MaterializeAsRotatedString", "Data", "Inflate", 776, 48),
      step("CommaSequenceWrapVariant", "Structural", "Inflate", 9),
      step("OpaquePredicateVariantB", "AntiAnalysis", "Inflate", 926),
      step("CommaSequenceWrapVariant", "Structural", "Inflate", 9),
    ],
  });
}

test("N. the region card drops location, Pro upsell, and the rows the transforms block repeats", async () => {
  const doc = docWithMachineryAsLastFile();
  doc.engine.complexity = 12;
  doc.files[0].regions[0] = regionWithChain();
  const v = await loadViewer(doc);
  const file = v.FILES[0];
  const html = v.cardRegion(file, file.regions[0], { cx: null });
  const keys = [...html.matchAll(/<span class="k">([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(keys, ["Complexity target", "Added size"]);
  for (const gone of [
    "chars ",
    "Copy Pro directive",
    "Ceiling",
    "Entropy",
    "Decode ops",
    "tier-pill",
    ">free<",
    "insp-where",
  ]) {
    assert.ok(!html.includes(gone), `"${gone}" is gone from the region card`);
  }
  assert.match(
    html,
    /<summary class="details-summary"[^>]*>Transforms <span class="chip">4<\/span>/,
    "the block counts distinct transforms, not steps",
  );
});

test("N2. the transforms list groups by name and captions each with what it does, never a rate", async () => {
  const doc = docWithMachineryAsLastFile();
  doc.files[0].regions[0] = regionWithChain();
  const v = await loadViewer(doc);
  const file = v.FILES[0];
  const groups = v.groupLineage(file.regions[0].raw.lineage);
  assert.equal(
    JSON.stringify(groups.map((g) => [g.transform, g.count])),
    JSON.stringify([
      ["LowerClass", 1],
      ["CommaSequenceWrapVariant", 4],
      ["MaterializeAsRotatedString", 1],
      ["OpaquePredicateVariantB", 1],
    ]),
    "oldest first, one row per transform",
  );
  const body = v.renderChainBody(file.regions[0]);
  assert.ok(!/survives/.test(body), "no bare 'survives'");
  assert.match(
    body,
    /Materialize<wbr>As<wbr>Rotated<wbr>String<\/span>/,
    "long names break at word humps",
  );
  assert.match(
    body,
    /<\/div><div class="chain-caption"><span[^>]*>Hides values<\/span><\/div>/,
    "the category sits on the caption line under the name, alone",
  );
  assert.match(body, />×4<\/span>/);
  assert.match(body, /Rewrites syntax<\/span><\/div>/);
  assert.ok(!/\d%/.test(body), "no transform carries a percentage");

  const off = { raw: { lineage: [], transformCount: 3 } };
  assert.match(v.renderChainBody(off), /protectionMap\.detailed/);
});

test("O. every docs link the viewer can render resolves to a known docs page", async () => {
  const doc = docWithTree();
  doc.engine.complexity = 5;
  const v = await loadViewer(doc, { hash: "#file=src/lib/auth.ts" });
  for (const [key, path] of Object.entries(v.DOC)) {
    assert.match(path, /^\/docs\/[a-z-]+(#[A-Za-z-]+)?$/, `${key} is a docs path`);
    assert.equal(v.docUrl(key), `${["https", "//www.afterpack.dev"].join(":")}${path}`);
  }
  assert.equal(v.docUrl("nope"), null);

  const template = readFileSync(new URL("./template.html", import.meta.url), "utf8");
  const keys = new Set([
    ...[...template.matchAll(/data-doc(?:-link)?="([A-Za-z]+)"/g)].map((m) => m[1]),
    ...[...template.matchAll(/docLinkHtml\("([A-Za-z]+)"/g)].map((m) => m[1]),
    ...[...template.matchAll(/\bdoc: "([A-Za-z]+)"/g)].map((m) => m[1]),
    ...template
      .split("\n")
      .filter((line) => /tipAttrs\(|inspFlag\(/.test(line))
      .flatMap((line) =>
        [...line.matchAll(/(?<!plural\([^()]*), "([A-Za-z]+)"\)/g)].map((m) => m[1]),
      ),
  ]);
  for (const k of keys) assert.ok(k in v.DOC, `template references unknown docs key "${k}"`);

  const file = v.FILES[1];
  const rendered = [
    v.byId("file-summary-metrics").innerHTML,
    v.byId("engine-info").innerHTML,
    v.byId("file-tree").innerHTML,
    v.byId("weakspots-list").innerHTML,
    v.cardSpotlight(file, file.spotlights[0], null),
    v.cardSpotlight(file, file.spotlights[1], null),
  ].join("");
  for (const m of rendered.matchAll(/data-doc="([^"]*)"/g)) {
    assert.ok(v.docUrl(m[1]), `rendered data-doc="${m[1]}" resolves`);
  }
});

test("P. the copy a reader sees carries no internal jargon or overclaims", async () => {
  const doc = docWithComplexityLane();
  doc.files[0].regions[1] = regionWithChain();
  doc.files[0].regions[1].span = [CX_SRC.indexOf("beta"), CX_SRC.indexOf("beta") + 4];
  const v = await loadViewer(doc);
  const file = v.FILES[0];
  v.paintCode(file);
  const pieces = [
    v.byId("file-summary-metrics").innerHTML,
    v.byId("engine-info").innerHTML,
    v.byId("cx-legend").innerHTML,
    v.byId("cx-legend-note").innerHTML,
    v.byId("class-rows").innerHTML,
    v.byId("build-cx").getAttribute("data-tip"),
    v.byId("private-tag").getAttribute("data-tip"),
    v.byId("file-tree").innerHTML,
    v.byId("code-body").innerHTML,
    v.cardRegion(file, file.regions[1], { cx: 12 }),
    v.cardUnlit(file, { pos: 0, end: 5, type: "k" }),
    v.renderChainBody(file.regions[1]),
    JSON.stringify(v.INSP_COPY),
  ].join("\n");
  const banned = [
    /ledger/i,
    /entropy/i,
    /funnel/i,
    /injective/i,
    /engine-input/i,
    /\bMBA\b/,
    /infeasible/i,
    /unbreakable/i,
    /irreversib/i,
    /cannot be (undone|reversed)/i,
    /\/100\b/,
    /\bPro\b/,
    /survives</,
  ];
  for (const re of banned) assert.doesNotMatch(pieces, re);
});

test("Q. no map presents a region's score as a rate, whatever engine wrote it", async () => {
  const rows = (html) => [...html.matchAll(/<span class="k">([^<]*)<\/span>/g)].map((m) => m[1]);
  for (const [version, withChain] of [
    ["0.1.0", false],
    ["0.1.0-rc.1", true],
    ["0.1.1", false],
    ["0.2.0", true],
  ]) {
    const doc = docWithMachineryAsLastFile();
    doc.engine.version = version;
    if (withChain) doc.files[0].regions[0] = regionWithChain();
    doc.files[0].regions[1].score = 100;
    const v = await loadViewer(doc);
    for (const region of v.FILES[0].regions.slice(0, 2)) {
      const card = v.cardRegion(v.FILES[0], region, { cx: null });
      assert.deepEqual(
        rows(card).filter(
          (k) => !["Complexity target", "Added size", "Runtime decoders"].includes(k),
        ),
        [],
        `${version}: the card lists what the region went through, not a score`,
      );
      assert.ok(!/\d%/.test(card), `${version}: no percentage on the region card`);
    }
  }
});

test("Q2. the viewer reports coverage, never a chance of resisting deobfuscation", async () => {
  const template = readFileSync(new URL("./template.html", import.meta.url), "utf8");
  const banned = [/resist/i, /\bchance/i, /harder to reverse/i];
  for (const re of banned) assert.doesNotMatch(template, re, `the template never says ${re}`);

  const doc = docWithComplexityLane();
  doc.files[0].regions[1] = regionWithChain();
  doc.files[0].regions[1].span = [CX_SRC.indexOf("beta"), CX_SRC.indexOf("beta") + 4];
  const v = await loadViewer(doc);
  const file = v.FILES[0];
  v.state.selection = { regionIdx: 1, spotlightIdx: null, cx: 12 };
  v.renderInspector();
  const shown = [
    v.byId("inspector").innerHTML,
    v.byId("cx-legend-note").innerHTML,
    v.byId("build-cx").getAttribute("data-tip"),
    v.cardRegion(file, file.regions[1], { cx: 12 }),
    v.renderChainBody(file.regions[1]),
  ].join("\n");
  for (const re of banned) assert.doesNotMatch(shown, re);
  assert.match(
    shown,
    /Transforms <span class="chip">4<\/span>/,
    "what the region went through stays",
  );
});

test("R. a weak spot the map cannot place offers no jump, and says so", async () => {
  const doc = docWithTree();
  doc.files[1].spotlights[1].span = null;
  const v = await loadViewer(doc, { hash: "#file=src/lib/auth.ts" });
  const file = v.FILES[1];
  assert.equal(file.spotlights[0].positioned, true);
  assert.equal(file.spotlights[1].positioned, false);
  v.renderWeakSpots(file);
  const html = v.byId("weakspots-list").innerHTML;
  assert.match(html, /data-jump-spotlight="0"/);
  assert.ok(!/data-jump-spotlight="1"/.test(html), "no button that does nothing");
  assert.match(html, /can't point to where this sits in your source/);
});

const DECL_SRC = "var total = 1;\nconst k = total;\nlog(k);\n";

function docWithDeclarationLane({ lane = true } = {}) {
  const at = (text, from = 0) => {
    const i = DECL_SRC.indexOf(text, from);
    return [i, i + text.length];
  };
  const total = at("total");
  const k = at("k");
  return {
    schemaVersion: 5,
    spanUnits: "utf16",
    engine: { version: "9.9.9", seed: 7, preset: "light", complexity: 5 },
    files: [
      {
        file: {
          path: "src/decl.ts",
          sourceOrigin: "original",
          vendor: false,
          originalSource: DECL_SRC,
          inputSize: DECL_SRC.length,
          outputSize: 90,
          outputSizeEstimated: false,
          inflationRatio: 2,
        },
        regions: [region({ span: at("1"), score: 78 })],
        spotlights: [],
        renamedSpans: [total],
        extractedSpans: [],
        ...(lane
          ? {
              declarationKinds: ["LowerVarToLet", "LowerBindingToParameter", "DeclarationChaining"],
              declarationSpans: [...total, 0, ...total, 2, ...k, 1],
            }
          : {}),
        aggregate: { weakRegions: 0, leakCount: 0, renamedCount: 1, extractedCount: 0 },
      },
    ],
  };
}

test("S. a declaration reshape adds one quiet line to the card and changes nothing else", async () => {
  const withLane = await loadViewer(docWithDeclarationLane());
  const without = await loadViewer(docWithDeclarationLane({ lane: false }));
  const a = withLane.FILES[0];
  const b = without.FILES[0];
  assert.equal(JSON.stringify(a.coverage), JSON.stringify(b.coverage));
  for (let pos = 0; pos < DECL_SRC.length; pos++) {
    const ra = a.mergedRuns.find((r) => r.start <= pos && r.end > pos);
    const rb = b.mergedRuns.find((r) => r.start <= pos && r.end > pos);
    const pa = withLane.runPaint(ra, ra.regionIdx == null ? null : a.regions[ra.regionIdx]);
    const pb = without.runPaint(rb, rb.regionIdx == null ? null : b.regions[rb.regionIdx]);
    assert.deepEqual(
      [pa.cls, pa.bucket, ra.regionIdx, ra.renamedIdx],
      [pb.cls, pb.bucket, rb.regionIdx, rb.renamedIdx],
      `char ${pos}`,
    );
  }

  withLane.paintCode(a);
  const painted = withLane.byId("code-body").innerHTML;
  const tok = painted.match(/<span class="tok[^"]*tok-hot[^"]*"[^>]*data-renamed-idx="0"[^>]*>/)[0];
  const data = (name) => (tok.match(new RegExp(`data-${name}="([^"]*)"`)) || [])[1];
  withLane.handleTokActivate({
    classList: { contains: (c) => c === "tok-hot" },
    dataset: {
      regionIdx: data("region-idx"),
      spotlightIdx: data("spotlight-idx"),
      renamedIdx: data("renamed-idx"),
      declIdx: data("decl-idx"),
    },
  });
  const insp = withLane.byId("inspector").innerHTML;
  assert.match(insp, />Renamed</, "the card it already showed stays");
  assert.match(
    insp,
    /<p class="insp-note insp-also">Also rewritten: Lower<wbr>Var<wbr>To<wbr>Let, Declaration<wbr>Chaining<\/p>/,
  );
  assert.equal(withLane.inspectorSummary(a, withLane.state.selection), "renamed");

  const kAt = DECL_SRC.indexOf("k");
  withLane.selectUnlit(kAt, "i", kAt + 1);
  assert.match(withLane.byId("inspector").innerHTML, /Nothing recorded/);
  assert.match(
    withLane.byId("inspector").innerHTML,
    /Also rewritten: Lower<wbr>Binding<wbr>To<wbr>Parameter</,
  );

  withLane.selectUnlit(DECL_SRC.indexOf("log"), "i", DECL_SRC.indexOf("log") + 3);
  assert.ok(
    !withLane.byId("inspector").innerHTML.includes("Also rewritten"),
    "only a reshaped name gets the line",
  );
});

test("S2. a map from an engine without the declaration lane renders exactly as before", async () => {
  const v = await loadViewer(docWithDeclarationLane({ lane: false }));
  const f = v.FILES[0];
  assert.equal(f.declRanges.length, 0);
  assert.ok(f.mergedRuns.every((r) => r.declIdx == null));
  v.paintCode(f);
  assert.ok(!v.byId("code-body").innerHTML.includes("data-decl-idx"));
  const run = f.mergedRuns.find((r) => r.renamedIdx === 0);
  v.state.selection = {
    regionIdx: null,
    spotlightIdx: null,
    renamedIdx: 0,
    extractedIdx: null,
    cx: run.cx,
    unlit: null,
  };
  v.renderInspector();
  assert.ok(!v.byId("inspector").innerHTML.includes("Also rewritten"));
  v.selectUnlit(DECL_SRC.indexOf("k"), "i", DECL_SRC.indexOf("k") + 1);
  assert.ok(!v.byId("inspector").innerHTML.includes("Also rewritten"));
});
