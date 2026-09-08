import assert from "node:assert/strict";
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
      c.region + c.extracted + c.renamed + c.plain,
      c.total,
      "buckets must sum to the file length",
    );
    for (const k of ["region", "extracted", "renamed", "plain"]) {
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

test("B. the machinery entry is not labelled as the customer's original source", async () => {
  const v = await loadViewer(docWithMachineryAsLastFile());
  const note = v.byId("source-origin-note");

  v.updateSourceOriginNote(v.FILES[1]);
  assert.equal(v.sourceOriginOf(v.FILES[1]), "machinery");
  assert.match(note.textContent, /engine note \(not your source\)/);
  assert.doesNotMatch(note.textContent, /original/i);
  assert.doesNotMatch(note.textContent, /engine-input/i);
  assert.match(note.getAttribute("data-tip"), /Not one of your files/);

  v.updateSourceOriginNote(v.FILES[0]);
  assert.equal(
    note.textContent,
    "source: original (via source map)",
    "the original-source origin keeps its existing wording",
  );
  const ei = { doc: { file: { sourceOrigin: "engineInput" } } };
  v.updateSourceOriginNote(ei);
  assert.equal(
    note.textContent,
    "source: engine-input",
    "the engine-input origin keeps its existing wording",
  );
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

test("D. cardUnlit prints all four disjoint coverage buckets", async () => {
  const v = await loadViewer(docWithMachineryAsLastFile());
  const file = v.FILES[0];
  const html = v.cardUnlit(file, { pos: 0, end: 5, type: "k" });
  const keys = [...html.matchAll(/<span class="k">([^<]*)<\/span>/g)].map((m) => m[1]);
  for (const k of ["Ledger region", "Extracted only", "Renamed only", "Plain"]) {
    assert.ok(keys.includes(k), `cardUnlit is missing the "${k}" row; got ${JSON.stringify(keys)}`);
  }
  assert.ok(!keys.includes("Grammar"), "the Grammar row duplicated the toolbar's own label");
  assert.equal(keys.length, 6, "INSP_FACTS pins every card at exactly six rows");
  assert.ok(!html.includes("is-pad"), "no padding row: the six facts fill the card exactly");
  const c = file.coverage;
  assert.equal(
    c.region + c.extracted + c.renamed + c.plain,
    c.total,
    "the four printed percentages are the four disjoint coverage buckets",
  );
  const pct = (n) => `${Math.round((n / c.total) * 100)}%`;
  for (const n of [c.region, c.extracted, c.renamed, c.plain])
    assert.ok(html.includes(`>${pct(n)}<`));
  for (const k of ["Ledger region", "Extracted only", "Renamed only", "Plain"]) {
    assert.ok(
      v.INSP_COPY.coverage.includes(k),
      `the shared tooltip INSP_COPY.coverage names "${k}"`,
    );
  }
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
  assert.match(v.byId("workspace-summary").getAttribute("data-tip"), /1 leaked literal/);
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

test("I. a stored v4 blob still renders, and its two renamed rows degrade visibly", async () => {
  const { byId } = await loadViewer(v4DocWithPreRenameEngineHeader());
  const info = byId("engine-info").innerHTML;
  assert.match(info, /IrAuthoritative/, "backend still renders");
  assert.match(info, /<dt>seed<\/dt><dd>42<\/dd>/, "seed still renders");
  assert.match(info, /<dt>materialize<\/dt><dd>on<\/dd>/, "materialize still renders");
  assert.match(info, /<dt>schema<\/dt><dd>v4<\/dd>/, "the blob still declares its own version");
  assert.match(
    info,
    /<dt>complexity<\/dt><dd>—<\/dd>/,
    "a field renamed since v4 reads as unknown, never as a fabricated value or a throw that costs the reader the whole map",
  );
  assert.match(
    info,
    /<dt>preset<\/dt><dd>Hard<\/dd>/,
    "a field still spelled the same renders in its old case",
  );
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
  assert.equal(v.byId("inspector-count").textContent, "unattributed token");
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
  assert.match(clean.byId("weakspots-list").innerHTML, /None recorded in this file/);
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
