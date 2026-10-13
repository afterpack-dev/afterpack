import { basename, resolve } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import type { InMemoryInput, InMemoryOutput } from "./pass.js";
import type { ReportPolicy } from "./policy.js";
import { type SourceType, sourceTypeForOutputFormat } from "./registry.js";
import { withoutCssSourceMappingURL, withSourceMappingURL } from "./source-map.js";

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

const CSS_MAP_RE = /\.css\.map$/;

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
    inputs.set(filePath, { source, sourceMap: entry.map ? entry.map.toString() : null });
  }
  return { files, inputs, entries };
}

export function sourceTypeForBundle(
  format: string | null | undefined,
  entries: Iterable<BundleEntryLike>,
): SourceType | undefined {
  for (const entry of entries) {
    if (entry.type !== "chunk") return undefined;
  }
  return sourceTypeForOutputFormat(format);
}

const COMPRESSED_SIBLING = /\.(gz|br|zst|zz|deflate)$/;

function entryBytes(entry: BundleEntryLike): Buffer | null {
  if (entry.type === "chunk") return entry.code === undefined ? null : Buffer.from(entry.code);
  if (typeof entry.source === "string") return Buffer.from(entry.source);
  if (entry.source !== undefined) return Buffer.from(entry.source);
  return null;
}

export function regenerateCompressedSiblings(
  bundle: OutputBundleLike,
  obfuscated: ReadonlySet<string>,
  label: string,
): void {
  for (const [name, entry] of Object.entries(bundle)) {
    const match = COMPRESSED_SIBLING.exec(name);
    if (match === null) continue;
    const base = name.slice(0, -match[0].length);
    if (!obfuscated.has(base)) continue;
    const bytes = entryBytes(bundle[base]);
    if (bytes === null) continue;
    if (match[1] === "gz") entry.source = gzipSync(bytes);
    else if (match[1] === "br") entry.source = brotliCompressSync(bytes);
    else {
      throw new Error(
        `[${label}] ${name} is a ${match[1]} copy of the obfuscated ${base}, but AfterPack can only ` +
          "regenerate .gz and .br. The precompressed file would hold the plain bytes. Drop the " +
          `${match[1]} compressor, or move it after AfterPack.`,
      );
    }
  }
}

const SRI_PLUGIN_NAME = /subresource|integrity|(?:^|[^a-z])sri(?:[^a-z]|$)/i;

export function sriPluginRefusal(
  plugins: readonly { name?: string }[] | undefined,
  label: string,
): string | null {
  const found = (plugins ?? []).find((plugin) => SRI_PLUGIN_NAME.test(plugin?.name ?? ""));
  if (!found) return null;
  return (
    `[${label}] the "${found.name}" plugin computes subresource integrity hashes, which AfterPack ` +
    "cannot support: unless it runs strictly after obfuscation, the integrity attributes pin the " +
    "plain bytes and the browser blocks every script. AfterPack cannot see plugin ordering, so it " +
    "refuses. Remove the SRI plugin, or compute integrity from the deployed files after the build."
  );
}

export function unsaltedAssetsWarning(
  entries: ReadonlyMap<string, BundleEntryLike>,
  salted: ReadonlySet<string>,
): string | null {
  const fileNames: string[] = [];
  for (const entry of entries.values()) {
    if (entry.type !== "chunk" && !salted.has(entry.fileName)) fileNames.push(entry.fileName);
  }
  fileNames.sort();
  if (fileNames.length === 0) return null;
  return (
    `${fileNames.length} JS file(s) reached the bundle as plain assets rather than chunks ` +
    `(${fileNames.join(", ")}); the bundler fixed their content-hashed names before obfuscation, ` +
    "so each keeps its name while its bytes change. Serve them without long-lived caching, or " +
    "import them as modules so the bundler builds them as chunks."
  );
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

export function stripBundleCssSourceMaps(bundle: OutputBundleLike): void {
  for (const [fileName, entry] of Object.entries(bundle)) {
    if (CSS_MAP_RE.test(fileName)) {
      delete bundle[fileName];
      continue;
    }
    if (entry.type !== "asset" || !fileName.endsWith(".css") || entry.source === undefined)
      continue;
    const css =
      typeof entry.source === "string" ? entry.source : Buffer.from(entry.source).toString("utf8");
    const stripped = withoutCssSourceMappingURL(css);
    if (stripped !== css) entry.source = stripped;
  }
}
