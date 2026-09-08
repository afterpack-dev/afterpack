import { basename, resolve } from "node:path";
import type { InMemoryInput, InMemoryOutput } from "./pass.js";
import type { ReportPolicy } from "./policy.js";
import { withSourceMappingURL } from "./source-map.js";

export interface BundleEntryLike {
  type: string;
  fileName: string;
  code?: string;
  source?: string | Uint8Array;
  map?: { toString(): string } | null;
  sourcemapFileName?: string | null;
  modules?: Record<string, unknown>;
}

export type OutputBundleLike = Record<string, BundleEntryLike>;

export interface BundleJs {
  files: string[];
  inputs: Map<string, InMemoryInput>;
  entries: Map<string, BundleEntryLike>;
}

const BUNDLE_JS_RE = /\.[cm]?js$/;

export function collectBundleJs(bundle: OutputBundleLike, outDir: string): BundleJs {
  const files: string[] = [];
  const inputs = new Map<string, InMemoryInput>();
  const entries = new Map<string, BundleEntryLike>();
  for (const [fileName, entry] of Object.entries(bundle)) {
    if (!BUNDLE_JS_RE.test(fileName)) continue;
    const source =
      entry.type === "chunk"
        ? entry.code
        : typeof entry.source === "string"
          ? entry.source
          : undefined;
    if (source === undefined) continue;
    const filePath = resolve(outDir, fileName);
    files.push(filePath);
    entries.set(filePath, entry);
    inputs.set(filePath, { source, inputSourceMap: entry.map ? entry.map.toString() : null });
  }
  return { files, inputs, entries };
}

function dataUri(json: string): string {
  return `data:application/json;charset=utf-8;base64,${Buffer.from(json, "utf8").toString("base64")}`;
}

export function applyBundleOutput(
  bundle: OutputBundleLike,
  entry: BundleEntryLike,
  out: InMemoryOutput,
  policy: ReportPolicy,
): void {
  if (entry.type !== "chunk") {
    entry.source = out.code;
    return;
  }
  const mapName = entry.sourcemapFileName ?? null;
  const inlineMap = mapName == null && entry.map != null;
  const emitMap = policy.sourceMap && out.sourceMap != null;
  let url: string | null = null;
  if (emitMap && out.sourceMap != null) {
    if (mapName != null && bundle[mapName]) {
      bundle[mapName].source = out.sourceMap;
      url = basename(mapName);
    } else if (inlineMap) {
      url = dataUri(out.sourceMap);
    }
  } else {
    if (mapName != null) delete bundle[mapName];
    entry.map = null;
  }
  entry.code = withSourceMappingURL(out.code, policy.emitSourceMappingURL ? url : null);
}
