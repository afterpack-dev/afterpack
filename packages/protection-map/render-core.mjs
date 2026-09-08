import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { encodeCompact } from "./codec.mjs";

export { decodeCompact, encodeCompact } from "./codec.mjs";

export const LINEAGE_EMBED_CAP = 20;
export const PLACEHOLDER = "__AFTERPACK_DATA__";

export function defaultTemplatePath() {
  return fileURLToPath(new URL("./template.html", import.meta.url));
}

export function readDefaultTemplate() {
  return readFileSync(defaultTemplatePath(), "utf8");
}

export function normalizeToFiles(raw) {
  if (raw && Array.isArray(raw.files)) return raw;
  return { files: [raw] };
}

export function capLineage(data) {
  let cappedRegions = 0;
  let totalLineageStepsRemoved = 0;
  for (const fileDoc of data.files || []) {
    for (const region of fileDoc?.regions || []) {
      if (Array.isArray(region.lineage) && region.lineage.length > LINEAGE_EMBED_CAP) {
        const originalLength = region.lineage.length;
        region.lineage = region.lineage.slice(0, LINEAGE_EMBED_CAP);
        region.lineageCapped = originalLength;
        cappedRegions += 1;
        totalLineageStepsRemoved += originalLength - LINEAGE_EMBED_CAP;
      }
    }
  }
  return { cappedRegions, totalLineageStepsRemoved };
}

export function embedIntoTemplate(template, data) {
  const occurrences = template.split(PLACEHOLDER).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `expected exactly one "${PLACEHOLDER}" sentinel in the template, found ${occurrences}`,
    );
  }
  const safeJson = JSON.stringify(data).replace(/</g, "\\u003c");
  return template.replace(PLACEHOLDER, () => safeJson);
}

function stripLineage(data) {
  for (const fileDoc of data.files || []) {
    for (const region of fileDoc?.regions || []) {
      if (Array.isArray(region.lineage) && region.lineage.length > 0) region.lineage = [];
      if (region.lineageCapped != null) delete region.lineageCapped;
    }
  }
}

function embedCompact(template, compact) {
  const occurrences = template.split(PLACEHOLDER).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `expected exactly one "${PLACEHOLDER}" sentinel in the template, found ${occurrences}`,
    );
  }
  const json = JSON.stringify(compact);
  const base64 = gzipSync(Buffer.from(json, "utf8"), { level: 9 }).toString("base64");
  return template.replace(PLACEHOLDER, () => base64);
}

export function renderProtectionMapHtml(raw, { template, includeLineage = true } = {}) {
  const data = normalizeToFiles(raw);
  let cappedRegions = 0;
  let totalLineageStepsRemoved = 0;
  if (includeLineage) {
    ({ cappedRegions, totalLineageStepsRemoved } = capLineage(data));
  } else {
    stripLineage(data);
  }
  const compact = encodeCompact(data, { includeLineage });
  const html = embedCompact(template ?? readDefaultTemplate(), compact);
  return { html, files: data.files.length, cappedRegions, totalLineageStepsRemoved };
}
