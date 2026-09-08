#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { LINEAGE_EMBED_CAP, renderProtectionMapHtml } from "./render-core.mjs";

function usageAndExit() {
  console.error("usage: node render.mjs <protmap.json> <template.html> <out.html> [--no-lineage]");
  process.exit(2);
}

function main() {
  const [, , jsonPath, templatePath, outPath, ...rest] = process.argv;
  if (!jsonPath || !templatePath || !outPath) usageAndExit();
  const includeLineage = !rest.includes("--no-lineage");

  let raw;
  try {
    raw = JSON.parse(readFileSync(jsonPath, "utf8"));
  } catch (err) {
    console.error(`failed to read/parse ${jsonPath}: ${err.message}`);
    process.exit(1);
  }

  let template;
  try {
    template = readFileSync(templatePath, "utf8");
  } catch (err) {
    console.error(`failed to read template ${templatePath}: ${err.message}`);
    process.exit(1);
  }

  let result;
  try {
    result = renderProtectionMapHtml(raw, { template, includeLineage });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  writeFileSync(outPath, result.html, "utf8");

  const bytes = Buffer.byteLength(result.html, "utf8");
  console.log(`wrote ${outPath} (${(bytes / 1024).toFixed(1)} KB, ${result.files} file(s))`);
  if (result.cappedRegions > 0) {
    console.log(
      `capped lineage on ${result.cappedRegions} region(s) to ${LINEAGE_EMBED_CAP} entries ` +
        `(${result.totalLineageStepsRemoved} steps trimmed total; region.lineageCapped records the original count)`,
    );
  }
}

main();
