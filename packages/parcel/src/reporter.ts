import { rmSync } from "node:fs";
import { join, relative } from "node:path";
import { PROTECTION_RECEIPT_FILE, writeProtectionReceipt } from "@afterpack/integration-utils";
import { Reporter } from "@parcel/plugin";
import type { PackagedBundle } from "@parcel/types";
import { escapeParcelMarkdown } from "./markdown.js";
import { type BundleRecord, clearBundleRecords, readBundleRecord } from "./records.js";

const LABEL = "afterpack-parcel";

interface DistTree {
  files: string[];
  records: BundleRecord[];
  transformed: string[];
  unrecorded: string[];
}

function shipsObfuscatedJs(bundle: PackagedBundle): boolean {
  return bundle.type === "js" && bundle.env.shouldOptimize && bundle.bundleBehavior !== "inline";
}

function agreed<T>(values: T[]): T | null {
  const distinct = [...new Set(values)];
  return distinct.length === 1 ? distinct[0] : null;
}

function joined(values: string[]): string {
  return [...new Set(values)].join(",");
}

function collectDistTrees(
  bundles: readonly PackagedBundle[],
  projectRoot: string,
): Map<string, DistTree> {
  const trees = new Map<string, DistTree>();
  for (const bundle of bundles) {
    if (!shipsObfuscatedJs(bundle)) continue;
    const dir = bundle.target.distDir;
    let tree = trees.get(dir);
    if (!tree) {
      tree = { files: [], records: [], transformed: [], unrecorded: [] };
      trees.set(dir, tree);
    }
    const record = readBundleRecord(projectRoot, bundle.id);
    if (!record) {
      tree.unrecorded.push(relative(projectRoot, bundle.filePath));
      continue;
    }
    tree.files.push(bundle.filePath);
    tree.records.push(record);
    if (record.transformed) tree.transformed.push(bundle.filePath);
  }
  return trees;
}

export default new Reporter({
  report({ event, options, logger }) {
    if (event.type === "buildStart") clearBundleRecords(options.projectRoot);
    if (event.type !== "buildSuccess") return;
    const trees = collectDistTrees(event.bundleGraph.getBundles(), options.projectRoot);
    for (const [dir, tree] of trees) {
      const receiptPath = join(dir, PROTECTION_RECEIPT_FILE);
      if (tree.unrecorded.length > 0) {
        rmSync(receiptPath, { force: true });
        logger.warn({
          message: escapeParcelMarkdown(
            `[${LABEL}] no protection receipt for ${relative(options.projectRoot, dir)}: AfterPack ` +
              `has no record of obfuscating ${tree.unrecorded.join(", ")} in this build. Keep ` +
              "@afterpack/parcel-optimizer in .parcelrc and build.autorun on; a bundle Parcel " +
              "reused from .parcel-cache has no record either, so clear .parcel-cache and rebuild.",
          ),
        });
        continue;
      }
      const records = tree.records;
      writeProtectionReceipt({
        dir,
        tool: records[0].tool,
        engine: agreed(records.map((r) => r.engine)),
        engineVersion: agreed(records.map((r) => r.engineVersion)),
        seed: joined(records.map((r) => r.seed)),
        seedOrigin: joined(records.map((r) => r.seedOrigin)),
        bundler: "parcel",
        buildId: null,
        files: tree.files,
        transformed: tree.transformed,
      });
      logger.info({
        message: escapeParcelMarkdown(
          `[${LABEL}] wrote protection receipt -> ${receiptPath} (afterpack verify)`,
        ),
      });
    }
  },
});
