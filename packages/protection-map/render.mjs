#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { LINEAGE_EMBED_CAP, renderProtectionMapHtml } from "./render-core.mjs";

function usageAndExit() {
  console.error(
    "usage: afterpack-protection-map <protmap.json> <out.html> [--template <file>] [--no-lineage]",
  );
  process.exit(2);
}

function main() {
  const positional = [];
  let includeLineage = true;
  let templatePath;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--no-lineage") includeLineage = false;
    else if (args[i] === "--template") templatePath = args[++i] ?? usageAndExit();
    else positional.push(args[i]);
  }
  const [jsonPath, outPath] = positional;
  if (!jsonPath || !outPath || positional.length > 2) usageAndExit();

  let raw;
  try {
    raw = JSON.parse(readFileSync(jsonPath, "utf8"));
  } catch (err) {
    console.error(`failed to read/parse ${jsonPath}: ${err.message}`);
    process.exit(1);
  }

  let template;
  if (templatePath) {
    try {
      template = readFileSync(templatePath, "utf8");
    } catch (err) {
      console.error(`failed to read template ${templatePath}: ${err.message}`);
      process.exit(1);
    }
  }

  let result;
  try {
    result = renderProtectionMapHtml(
      raw,
      template ? { template, includeLineage } : { includeLineage },
    );
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
