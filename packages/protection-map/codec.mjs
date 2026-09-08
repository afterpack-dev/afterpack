export const COMPACT_SCHEMA_VERSION = 5;

const DICT_FIELDS = [
  "nodeKind",
  "preservedReason",
  "reversalClass",
  "band",
  "costClass",
  "transform",
  "category",
  "phase",
  "severity",
  "mechanism",
  "disposition",
  "reason",
  "proHint",
];

const REGION_COLUMNS = [
  "span",
  "nodeKind",
  "preservedReason",
  "reversalClass",
  "score",
  "entropyRaw",
  "transformCount",
  "sizeDeltaEst",
  "costClass",
  "decodeOps",
  "callFrames",
  "band",
];
const SPOTLIGHT_COLUMNS = [
  "span",
  "severity",
  "mechanism",
  "disposition",
  "sample",
  "bytes",
  "reason",
  "proHint",
  "reversalClass",
];
const LINEAGE_COLUMNS = ["transform", "category", "phase", "entropyGain", "sizeDeltaEst", "label"];

function regionScalar(r, col) {
  switch (col) {
    case "span":
      return r.span;
    case "nodeKind":
      return r.nodeKind;
    case "preservedReason":
      return r.preservedReason;
    case "reversalClass":
      return r.reversalClass;
    case "score":
      return r.score;
    case "entropyRaw":
      return r.entropyRaw;
    case "transformCount":
      return r.transformCount;
    case "sizeDeltaEst":
      return r.sizeDeltaEst;
    case "costClass":
      return r.perf ? r.perf.costClass : undefined;
    case "decodeOps":
      return r.perf ? r.perf.decodeOps : undefined;
    case "callFrames":
      return r.perf ? r.perf.callFrames : undefined;
    case "band":
      return r.band;
    default:
      return undefined;
  }
}

function spotScalar(s, col) {
  switch (col) {
    case "span":
      return s.span;
    case "severity":
      return s.severity;
    case "mechanism":
      return s.mechanism;
    case "disposition":
      return s.disposition;
    case "sample":
      return s.sample;
    case "bytes":
      return s.bytes;
    case "reason":
      return s.reason;
    case "proHint":
      return s.proHint;
    case "reversalClass":
      return s.reversalClass;
    default:
      return undefined;
  }
}

export function encodeCompact(data, { includeLineage = true } = {}) {
  const files = data && Array.isArray(data.files) ? data.files : [];

  const dictMaps = new Map();
  const dict = {};
  for (const f of DICT_FIELDS) {
    dictMaps.set(f, new Map());
    dict[f] = [];
  }
  const isNullHole = (value) => value == null;
  const intern = (field, value) => {
    if (isNullHole(value)) return value;
    const m = dictMaps.get(field);
    let idx = m.get(value);
    if (idx === undefined) {
      idx = dict[field].length;
      dict[field].push(value);
      m.set(value, idx);
    }
    return idx;
  };
  const isDict = (col) => dictMaps.has(col);

  const legend = {};

  const encFiles = files.map((fdoc) => {
    const regions = fdoc && Array.isArray(fdoc.regions) ? fdoc.regions : [];
    const spotlights = fdoc && Array.isArray(fdoc.spotlights) ? fdoc.spotlights : [];

    for (const r of regions) {
      const cls = r?.reversalClass;
      if (cls != null && !(cls in legend)) {
        legend[cls] = {
          why: r.why == null ? null : r.why,
          tier: r.tier == null ? null : r.tier,
          ceiling: r.ceiling == null ? null : r.ceiling,
        };
      }
    }

    const rcols = {};
    for (const col of REGION_COLUMNS) {
      const dictted = isDict(col);
      const arr = new Array(regions.length);
      for (let i = 0; i < regions.length; i++) {
        const v = regionScalar(regions[i], col);
        arr[i] = dictted ? intern(col, v) : v;
      }
      rcols[col] = arr;
    }

    if (includeLineage) {
      const lin = new Array(regions.length);
      const capped = {};
      let hasLineage = false;
      let hasCapped = false;
      for (let i = 0; i < regions.length; i++) {
        const steps = regions[i] && Array.isArray(regions[i].lineage) ? regions[i].lineage : [];
        if (steps.length) hasLineage = true;
        lin[i] = steps.map((st) => [
          intern("transform", st.transform),
          intern("category", st.category),
          intern("phase", st.phase),
          st.entropyGain,
          st.sizeDeltaEst,
          st.label == null ? null : st.label,
        ]);
        const lc = regions[i]?.lineageCapped;
        if (lc != null) {
          capped[i] = lc;
          hasCapped = true;
        }
      }
      if (hasLineage) rcols.lineage = lin;
      if (hasCapped) rcols.lineageCapped = capped;
    }

    const scols = {};
    for (const col of SPOTLIGHT_COLUMNS) {
      const dictted = isDict(col);
      const arr = new Array(spotlights.length);
      for (let j = 0; j < spotlights.length; j++) {
        const v = spotScalar(spotlights[j], col);
        arr[j] = dictted ? intern(col, v) : v;
      }
      scols[col] = arr;
    }

    return {
      file: fdoc.file,
      regions: { n: regions.length, cols: rcols },
      spotlights: { n: spotlights.length, cols: scols },
      aggregate: fdoc.aggregate,
      ...(fdoc.renamedSpans?.length ? { renamedSpans: fdoc.renamedSpans } : {}),
      ...(fdoc.extractedSpans?.length ? { extractedSpans: fdoc.extractedSpans } : {}),
    };
  });

  const prunedDict = {};
  for (const f of DICT_FIELDS) {
    if (dict[f].length) prunedDict[f] = dict[f];
  }

  return {
    schemaVersion: COMPACT_SCHEMA_VERSION,
    ...(data && data.spanUnits !== undefined ? { spanUnits: data.spanUnits } : {}),
    generatedAt: data && data.generatedAt !== undefined ? data.generatedAt : null,
    engine: data && data.engine !== undefined ? data.engine : null,
    legend,
    dict: prunedDict,
    columns: { region: REGION_COLUMNS, spotlight: SPOTLIGHT_COLUMNS, lineage: LINEAGE_COLUMNS },
    files: encFiles,
  };
}

function afterpackDecodeDocument(c) {
  const dict = c.dict || {};
  const cols = c.columns || {};
  const regionCols = cols.region || [];
  const spotCols = cols.spotlight || [];
  const lineageCols = cols.lineage || [];
  const legend = c.legend || {};

  const decodeTable = (table, colNames) => {
    const n = table?.n || 0;
    const src = table?.cols || {};
    const rows = new Array(n);
    for (let i = 0; i < n; i++) rows[i] = {};
    for (const col of colNames) {
      const arr = src[col];
      const d = dict[col];
      for (let i = 0; i < n; i++) {
        const v = arr ? arr[i] : undefined;
        rows[i][col] = d ? d[v] : v;
      }
    }
    return { rows, src };
  };

  const files = (c.files || []).map((fc) => {
    const rdec = decodeTable(fc.regions, regionCols);
    const regions = rdec.rows;
    const rsrc = rdec.src;
    for (let i = 0; i < regions.length; i++) {
      const region = regions[i];
      const decodeOps = region.decodeOps;
      region.perf = { costClass: region.costClass, decodeOps, callFrames: region.callFrames };
      delete region.costClass;
      delete region.decodeOps;
      delete region.callFrames;
      region.lineage = rsrc.lineage
        ? (rsrc.lineage[i] || []).map((t) => {
            const step = {};
            for (let k = 0; k < lineageCols.length; k++) {
              const lc = lineageCols[k];
              step[lc] = dict[lc] ? dict[lc][t[k]] : t[k];
            }
            return step;
          })
        : [];
      if (rsrc.lineageCapped && rsrc.lineageCapped[i] != null) {
        region.lineageCapped = rsrc.lineageCapped[i];
      }
      const lg = legend[region.reversalClass] || {};
      region.why = lg.why == null ? undefined : lg.why;
      region.tier = lg.tier == null ? null : lg.tier;
      region.ceiling = lg.ceiling == null ? null : lg.ceiling;
      region.annotations = decodeOps > 0 ? ["materializationSite"] : [];
      region.outputSpan = null;
    }
    const sdec = decodeTable(fc.spotlights, spotCols);
    return {
      file: fc.file,
      regions,
      spotlights: sdec.rows,
      aggregate: fc.aggregate,
      renamedSpans: fc.renamedSpans || [],
      extractedSpans: fc.extractedSpans || [],
    };
  });

  return {
    schemaVersion: c.schemaVersion,
    ...(c.spanUnits !== undefined ? { spanUnits: c.spanUnits } : {}),
    generatedAt: c.generatedAt !== undefined ? c.generatedAt : null,
    engine: c.engine !== undefined ? c.engine : null,
    files,
  };
}

export { afterpackDecodeDocument, afterpackDecodeDocument as decodeCompact };
