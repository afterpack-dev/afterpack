import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { decodeCompact, encodeCompact } from "./codec.mjs";
import { embedIntoTemplate, PLACEHOLDER, renderProtectionMapHtml } from "./render-core.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const require = createRequire(here("../../package.json"));
const ts = require("typescript");

function extractBalancedFunction(source, startMarker, label) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `${startMarker} found in ${label}`);
  let depth = 0;
  let end = -1;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert.ok(end > start, `${startMarker} braces balance in ${label}`);
  return source.slice(start, end);
}

function stripCommentsAndNormalizeWhitespace(snippet) {
  const sourceFile = ts.createSourceFile(
    "snippet.js",
    snippet,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const ranges = new Map();
  const visit = (node) => {
    for (const r of ts.getLeadingCommentRanges(snippet, node.getFullStart()) || []) {
      ranges.set(`${r.pos}:${r.end}`, r);
    }
    for (const r of ts.getTrailingCommentRanges(snippet, node.end) || []) {
      ranges.set(`${r.pos}:${r.end}`, r);
    }
    for (const child of node.getChildren(sourceFile)) visit(child);
  };
  visit(sourceFile);
  let code = snippet;
  for (const r of [...ranges.values()].sort((a, b) => b.pos - a.pos)) {
    code = code.slice(0, r.pos) + code.slice(r.end);
  }
  return code
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function region(over) {
  const base = {
    span: [0, 4],
    nodeKind: "Lowered",
    preservedReason: null,
    reversalClass: "renamed-encoded",
    score: 53,
    tier: "free",
    why: "Identifiers renamed, constants rebuilt at use sites. Recoverable with effort. (Free)",
    ceiling: { class: "flattened-fused", directive: "preset=hard" },
    entropyRaw: 6,
    entropy: 0.5314,
    transformCount: 1,
    sizeDeltaEst: 12,
    perf: { costClass: "none", decodeOps: 0, callFrames: 0 },
    lineage: [],
    annotations: [],
    band: "inflatable",
    outputSpan: null,
  };
  return { ...base, ...over };
}

const PRESERVED_CLASS_WHY = "Third-party code or public contracts — left readable on purpose.";

function wholeFileBaselineRegion() {
  return region({
    span: [0, 27],
    nodeKind: "Program",
    reversalClass: "preserved",
    score: 0,
    tier: null,
    why: PRESERVED_CLASS_WHY,
    ceiling: null,
    entropyRaw: 0,
    entropy: 0,
    transformCount: 0,
  });
}

function materializationRegionWithLineage() {
  return region({
    span: [6, 7],
    perf: { costClass: "decode", decodeOps: 2, callFrames: 0 },
    annotations: ["materializationSite"],
    transformCount: 3,
    entropyRaw: 18,
    entropy: 0.6321,
    lineage: [
      {
        transform: "LowerClass",
        category: "Structural",
        phase: "Parse",
        entropyGain: 4,
        sizeDeltaEst: 0,
        label: null,
      },
      {
        transform: "MaterializeAsCachedString",
        category: "Data",
        phase: "Inflate",
        entropyGain: 6,
        sizeDeltaEst: 12,
        label: ["materializationKind", "cachedString"],
      },
      {
        transform: "MaterializeAsCachedString",
        category: "Data",
        phase: "Inflate",
        entropyGain: 8,
        sizeDeltaEst: 14,
        label: ["materializationKind", "cachedString"],
      },
    ],
    lineageCapped: 42,
  });
}

function preservedModuleSpecifierRegion() {
  return region({
    span: [13, 20],
    nodeKind: "Str",
    preservedReason: "module-specifier",
    reversalClass: "preserved",
    score: 0,
    tier: null,
    why: PRESERVED_CLASS_WHY,
    ceiling: null,
    entropyRaw: 0,
    entropy: 0,
    transformCount: 0,
  });
}

function richDoc() {
  return {
    schemaVersion: 3,
    generatedAt: null,
    engine: { version: "9.9.9", backend: "IrAuthoritative", seed: 42, preset: "hard" },
    files: [
      {
        file: {
          path: "src/app.js",
          sourceOrigin: "engineInput",
          vendor: false,
          originalSource: "const x = 1;\nconsole.log(x);\n",
          inputSize: 27,
          outputSize: 40,
          outputSizeEstimated: true,
          inflationRatio: 1.48,
        },
        regions: [
          wholeFileBaselineRegion(),
          materializationRegionWithLineage(),
          preservedModuleSpecifierRegion(),
        ],
        spotlights: [
          {
            span: [6, 7],
            severity: "leak",
            mechanism: "ReachableConst",
            disposition: "Leak",
            sample: "SECRET",
            bytes: 6,
            reason: "a readable literal survived un-protected in the output",
            proHint: "/* @afterpack extreme */",
            reversalClass: "preserved",
          },
        ],
        aggregate: {
          avgEntropy: 0.42,
          maxEntropy: 0.63,
          minEntropy: 0,
          totalTransforms: 3,
          weakRegions: 1,
          leakCount: 1,
          perfCostTotal: { decodeOps: 2, callFrames: 0 },
          sizeDeltaEstTotal: 26,
          classSummary: {
            preserved: 2,
            "renamed-encoded": 1,
            "flattened-fused": 0,
            "destroyed-fused": 0,
            maxClassReached: "renamed-encoded",
          },
          directives: [{ keyword: "destroy", span: [0, 4], target: 80, floor: true }],
        },
        renamedSpans: [
          [3, 7],
          [40, 46],
        ],
        extractedSpans: [12, 17, 0, 51, 58, 1],
      },
      vendorFileWithNoRegionsOrSpotlights(),
    ],
  };
}

function vendorFileWithNoRegionsOrSpotlights() {
  return {
    file: {
      path: "node_modules/dep/index.js",
      sourceOrigin: "original",
      vendor: true,
      originalSource: "module.exports = 1;\n",
      inputSize: 20,
      outputSize: 20,
      outputSizeEstimated: false,
      inflationRatio: 1,
    },
    regions: [],
    spotlights: [],
    aggregate: { classSummary: {} },
    renamedSpans: [],
    extractedSpans: [],
  };
}

function asDecoded(doc) {
  return {
    ...doc,
    schemaVersion: 5,
    files: doc.files.map((f) => ({
      ...f,
      regions: f.regions.map((r) => {
        const { entropy, ...rest } = r;
        return { ...rest, preservedReason: rest.preservedReason ?? undefined };
      }),
    })),
  };
}

test("encodeCompact -> decodeCompact round-trips the rich shape (minus dropped entropy)", () => {
  const rich = richDoc();
  const compact = encodeCompact(rich, { includeLineage: true });

  assert.equal(compact.schemaVersion, 5);
  assert.ok(compact.legend["renamed-encoded"].why, "legend carries the derived why");
  assert.ok(Array.isArray(compact.dict.nodeKind), "nodeKind interned into the dict");
  assert.ok(compact.dict.transform.includes("MaterializeAsCachedString"), "transform interned");
  assert.deepEqual(
    compact.dict.preservedReason,
    ["module-specifier"],
    "preservedReason interns like any other enum, one int per region, null regions left as holes",
  );
  assert.deepEqual(
    compact.files[0].regions.cols.preservedReason,
    [null, null, 0],
    "only the specifier region references the reason; the rest are null holes",
  );
  assert.equal(compact.files[0].regions.n, 3);
  assert.ok(Array.isArray(compact.files[0].regions.cols.span), "regions are columnar");
  assert.equal(compact.files[0].regions.cols.why, undefined, "why dropped from rows");
  assert.equal(compact.files[0].regions.cols.tier, undefined, "tier dropped from rows");

  const back = decodeCompact(compact);
  assert.equal(
    back.files[0].regions.find((r) => r.nodeKind === "Str").preservedReason,
    "module-specifier",
    "the viewer gets the reason back, not an empty `Reason -` row",
  );
  assert.deepEqual(back, asDecoded(rich));
});

test("template.html's inline decoder logic matches codec.mjs's afterpackDecodeDocument export", () => {
  const codec = readFileSync(here("./codec.mjs"), "utf8");
  const template = readFileSync(here("./template.html"), "utf8");
  const START = "function afterpackDecodeDocument(c) {";
  const codecFn = extractBalancedFunction(codec, START, "codec.mjs");
  const templateFn = extractBalancedFunction(template, START, "template.html");
  assert.equal(
    stripCommentsAndNormalizeWhitespace(templateFn),
    stripCommentsAndNormalizeWhitespace(codecFn),
    "template.html's inline afterpackDecodeDocument no longer matches codec.mjs's export",
  );
});

test("renderProtectionMapHtml embeds a gzip+base64 payload that inflates + decodes back", () => {
  const rich = richDoc();
  const { html } = renderProtectionMapHtml(rich, { includeLineage: true });

  assert.ok(!html.includes("__AFTERPACK_DATA__"), "the data sentinel is consumed");
  assert.ok(!/https?:\/\//i.test(html), "self-contained: no external URLs");
  assert.ok(!/<script[^>]+\bsrc=/i.test(html), "self-contained: no external script src");

  const m = html.match(/<script id="afterpack-data"[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(m, "embedded data block present");
  const payload = m[1].trim();
  assert.ok(payload.startsWith("H4sI"), "payload is base64 of a gzip stream");

  const json = gunzipSync(Buffer.from(payload, "base64")).toString("utf8");
  const back = decodeCompact(JSON.parse(json));
  assert.deepEqual(back, asDecoded(rich));

  const rawBytes = Buffer.byteLength(JSON.stringify(rich), "utf8");
  assert.ok(
    Buffer.byteLength(payload, "utf8") < rawBytes,
    "the compressed payload is smaller than the raw JSON",
  );
});

test("encodeCompact omits spanUnits rather than nulling it when the input predates the key", () => {
  const rich = richDoc();
  delete rich.spanUnits;
  const compact = encodeCompact(rich);
  assert.ok(!("spanUnits" in compact), "no spanUnits key on input that never had one");
});

test("encodeCompact carries spanUnits through verbatim when the input has one", () => {
  const rich = richDoc();
  rich.spanUnits = "utf16";
  const compact = encodeCompact(rich);
  assert.equal(compact.spanUnits, "utf16");
});

test("embedIntoTemplate escapes '<' so an embedded literal can't close the surrounding <script> tag", () => {
  const template = `<script id="d">${PLACEHOLDER}</script>`;
  const dangerous = { sample: "</script><script>alert(1)</script>" };
  const html = embedIntoTemplate(template, dangerous);

  assert.ok(
    !html.includes("</script><script>alert(1)</script>"),
    "no unescaped closing tag reaches the HTML",
  );
  const scriptBody = html.match(/<script id="d">([\s\S]*)<\/script>/)[1];
  assert.deepEqual(
    JSON.parse(scriptBody),
    dangerous,
    "the escape round-trips through JSON.parse unchanged",
  );
});

test("includeLineage:false drops every region's lineage (combined-map default)", () => {
  const rich = richDoc();
  const { html } = renderProtectionMapHtml(rich, { includeLineage: false });
  const payload = html.match(/<script id="afterpack-data"[^>]*>([\s\S]*?)<\/script>/)[1].trim();
  const back = decodeCompact(
    JSON.parse(gunzipSync(Buffer.from(payload, "base64")).toString("utf8")),
  );
  for (const f of back.files) {
    for (const r of f.regions) assert.deepEqual(r.lineage, [], "lineage dropped");
  }
});
