import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { renderProtectionMapHtml } from "@afterpack/protection-map";
import {
  type ArtifactMode,
  combinedProtectionMapPath,
  resolveArtifactPaths,
  shortHash,
} from "./paths.js";
import type { ReportPolicy } from "./policy.js";

export const AFTERPACK_DIR = ".afterpack";

export const GITIGNORE_ENTRIES = [
  ".afterpack/",
  "*.protectionMap.html",
  "protectionMap.html",
  "*.backup.*",
  "*.map",
];

const GITIGNORE_BLOCK_HEADER = "# AfterPack artifacts (auto-added)";

const PUBLIC_SEGMENTS = new Set([
  "public",
  "static",
  "assets",
  "dist",
  "build",
  "out",
  "www",
  "htdocs",
  "_next",
]);

export interface Logger {
  warn: (message: string) => void;
  log: (message: string) => void;
}

const DEFAULT_LOGGER: Logger = {
  warn: (m) => console.warn(m),
  log: (m) => console.log(m),
};

export interface WriteArtifactsInput {
  outPath: string;
  code: string;
  sourceMapJson: string | null;
  protectionMapJson: unknown | null;
  originalSource: string | null;
  policy: ReportPolicy;
  mode?: ArtifactMode;
  afterpackDir?: string;
  logger?: Logger;
}

export interface WriteArtifactsResult {
  codePath: string;
  mapPath: string | null;
  backupPath: string | null;
  protectionMapPath: string | null;
  wroteSourceMappingURL: boolean;
}

function appendSourceMappingURL(code: string, mapPath: string): string {
  const comment = `//# sourceMappingURL=${basename(mapPath)}`;
  if (code.includes(comment)) return code;
  const needsNewline = code.length > 0 && !code.endsWith("\n");
  return `${code}${needsNewline ? "\n" : ""}${comment}\n`;
}

export function writeArtifacts(input: WriteArtifactsInput): WriteArtifactsResult {
  const { outPath, code, sourceMapJson, protectionMapJson, originalSource, policy } = input;
  const mode = input.mode ?? "single";
  const afterpackDir = input.afterpackDir ?? AFTERPACK_DIR;
  const logger = input.logger ?? DEFAULT_LOGGER;

  const hash = policy.backup && originalSource != null ? shortHash(originalSource) : undefined;
  const paths = resolveArtifactPaths(outPath, mode, hash);

  const result: WriteArtifactsResult = {
    codePath: outPath,
    mapPath: null,
    backupPath: null,
    protectionMapPath: null,
    wroteSourceMappingURL: false,
  };

  if (policy.backup && originalSource != null && paths.backupPath != null) {
    writeFileSync(paths.backupPath, originalSource);
    result.backupPath = paths.backupPath;
  }

  const willWriteMap = policy.sourceMap && sourceMapJson != null;
  let finalCode = code;
  if (willWriteMap && policy.emitSourceMappingURL) {
    finalCode = appendSourceMappingURL(code, paths.mapPath);
    result.wroteSourceMappingURL = true;
  }

  writeFileSync(outPath, finalCode);

  if (willWriteMap && sourceMapJson != null) {
    writeFileSync(paths.mapPath, sourceMapJson);
    result.mapPath = paths.mapPath;
  }

  if (mode === "single" && policy.protectionMap && protectionMapJson != null) {
    mkdirSync(afterpackDir, { recursive: true });
    const pmPath = join(afterpackDir, basename(paths.protectionMapPath as string));
    if (policy.protectionMapInProd) {
      warnProtectionMapInProd(pmPath, logger);
    } else {
      logger.log(
        `[afterpack] wrote Protection Map -> ${pmPath} (gitignored; set protectionMap.enabled:false to skip)`,
      );
    }
    const { html } = renderProtectionMapHtml(protectionMapJson);
    writeFileSync(pmPath, html);
    result.protectionMapPath = pmPath;
  }

  return result;
}

export interface WriteCombinedProtectionMapInput {
  buildDir: string;
  docs: unknown[];
  policy: ReportPolicy;
  afterpackDir?: string;
  fileName?: string;
  logger?: Logger;
}

interface PmFileMeta {
  path?: string | null;
  sourceOrigin?: string;
  vendor?: boolean;
  originalSource?: string;
  inputSize?: number;
  bundledInputSize?: number;
  outputSize?: number;
  inflationRatio?: number;
  outputSizeEstimated?: boolean;
  [k: string]: unknown;
}

interface PmRegion {
  span?: [number, number];
  reversalClass?: string;
  entropy?: number;
  transformCount?: number;
  sizeDeltaEst?: number;
  lineage?: unknown[];
  perf?: { decodeOps?: number; callFrames?: number };
  [k: string]: unknown;
}

interface PmSpotlight {
  span?: [number, number] | null;
  severity?: string;
  sample?: string;
  mechanism?: string;
  [k: string]: unknown;
}

interface PmFileEntry {
  file?: PmFileMeta;
  regions?: PmRegion[];
  spotlights?: PmSpotlight[];
  renamedSpans?: [number, number][];
  extractedSpans?: number[];
  aggregate?: unknown;
  [k: string]: unknown;
}

interface PmAggregate {
  avgEntropy: number;
  maxEntropy: number;
  minEntropy: number;
  totalTransforms: number;
  weakRegions: number;
  leakCount: number;
  renamedCount: number;
  extractedCount: number;
  perfCostTotal: { decodeOps: number; callFrames: number };
  sizeDeltaEstTotal: number;
  classSummary: {
    preserved: number;
    "renamed-encoded": number;
    "flattened-fused": number;
    "destroyed-fused": number;
    maxClassReached: string;
  };
  directives: unknown[];
}

const REVERSAL_CLASS_ORDER = [
  "preserved",
  "renamed-encoded",
  "flattened-fused",
  "destroyed-fused",
] as const;

function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

export function isRuntimeSource(rawPath: string | null | undefined): boolean {
  const p = rawPath ?? "";
  if (p.includes("[turbopack]") || p.includes("[next]")) return true;
  if (/(^|\/)webpack\/(runtime|bootstrap)/.test(p)) return true;
  if (p.includes("webpack://_N_E/webpack/")) return true;
  if (/node_modules\/\.pnpm\/next[@/]/.test(p)) return true;
  if (/(^|\/)node_modules\/next\//.test(p)) return true;
  return false;
}

export function cleanSourcePath(rawPath: string | null | undefined): string {
  let p = rawPath ?? "";
  p = p.replace(/^turbopack:\/\/\/\[project\]\//, "");
  p = p.replace(/^turbopack:\/\/\//, "");
  p = p.replace(/^webpack:\/\/_N_E\/\.\//, "");
  p = p.replace(/^webpack:\/\/_N_E\//, "");
  p = p.replace(/^webpack:\/\//, "");
  p = p.replace(/^\.\//, "");
  p = p.replace(/node_modules\/\.pnpm\/[^/]+\/node_modules\//, "node_modules/");
  return p;
}

function computeAggregate(
  regions: PmRegion[],
  spotlights: PmSpotlight[],
  renamedCount = 0,
  directives: unknown[] = [],
  extractedCount = 0,
): PmAggregate {
  const regionCount = regions.length;
  let sumEntropy = 0;
  let maxEntropy = 0;
  let minEntropy = regionCount === 0 ? 0 : 1;
  let totalTransforms = 0;
  let decodeOps = 0;
  let callFrames = 0;
  let sizeDeltaEstTotal = 0;
  const classCounts = {
    preserved: 0,
    "renamed-encoded": 0,
    "flattened-fused": 0,
    "destroyed-fused": 0,
  };
  let maxClassRank = 0;

  for (const r of regions) {
    const e = typeof r.entropy === "number" ? r.entropy : 0;
    sumEntropy += e;
    if (e > maxEntropy) maxEntropy = e;
    if (e < minEntropy) minEntropy = e;
    totalTransforms += r.transformCount ?? (Array.isArray(r.lineage) ? r.lineage.length : 0);
    if (r.perf) {
      decodeOps += r.perf.decodeOps ?? 0;
      callFrames += r.perf.callFrames ?? 0;
    }
    sizeDeltaEstTotal += r.sizeDeltaEst ?? 0;
    const cls = r.reversalClass;
    if (cls != null && cls in classCounts) classCounts[cls as keyof typeof classCounts] += 1;
    const rank = REVERSAL_CLASS_ORDER.indexOf(cls as (typeof REVERSAL_CLASS_ORDER)[number]);
    if (rank > maxClassRank) maxClassRank = rank;
  }

  let leakCount = 0;
  for (const s of spotlights) if (s.severity === "leak") leakCount += 1;

  return {
    avgEntropy: round4(regionCount === 0 ? 0 : sumEntropy / regionCount),
    maxEntropy: round4(maxEntropy),
    minEntropy: round4(regionCount === 0 ? 0 : minEntropy),
    totalTransforms,
    renamedCount,
    extractedCount,
    weakRegions: spotlights.length,
    leakCount,
    perfCostTotal: { decodeOps, callFrames },
    sizeDeltaEstTotal,
    classSummary: { ...classCounts, maxClassReached: REVERSAL_CLASS_ORDER[maxClassRank] },
    directives,
  };
}

const SPAN_PACK_LIMIT = 1 << 25;

function packable(v: number, limit: number): boolean {
  return v >= 0 && v < limit && (v | 0) === v;
}

function spanKey(start: number, end: number, kind: number): number | string {
  if (packable(start, SPAN_PACK_LIMIT) && packable(end, SPAN_PACK_LIMIT) && packable(kind, 4)) {
    return (start * SPAN_PACK_LIMIT + end) * 4 + kind;
  }
  return `${start},${end},${kind}`;
}

function mergeEntries(entries: PmFileEntry[], path: string): PmFileEntry {
  const regions: PmRegion[] = [];
  const seenRegion = new Set<string>();
  const spotlights: PmSpotlight[] = [];
  const seenSpot = new Set<string>();

  const renamedSpans: [number, number][] = [];
  const seenRenamed = new Set<number | string>();

  const extractedFlat: number[] = [];
  const seenExtracted = new Set<number | string>();

  const directives: unknown[] = [];
  const seenDirective = new Set<string>();

  for (const e of entries) {
    for (const r of e.regions ?? []) {
      const key = Array.isArray(r.span) ? `${r.span[0]},${r.span[1]}` : `~${regions.length}`;
      if (seenRegion.has(key)) continue;
      seenRegion.add(key);
      regions.push(r);
    }
    for (const s of e.spotlights ?? []) {
      const sp = Array.isArray(s.span) ? `${s.span[0]},${s.span[1]}` : "";
      const key = `${sp}|${s.severity ?? ""}|${s.sample ?? ""}`;
      if (seenSpot.has(key)) continue;
      seenSpot.add(key);
      spotlights.push(s);
    }
    for (const rn of e.renamedSpans ?? []) {
      const key = spanKey(rn[0], rn[1], 0);
      if (seenRenamed.has(key)) continue;
      seenRenamed.add(key);
      renamedSpans.push(rn);
    }
    const flat = e.extractedSpans ?? [];
    for (let i = 0; i + 2 < flat.length; i += 3) {
      const key = spanKey(flat[i], flat[i + 1], flat[i + 2]);
      if (seenExtracted.has(key)) continue;
      seenExtracted.add(key);
      extractedFlat.push(flat[i], flat[i + 1], flat[i + 2]);
    }
    const agg = e.aggregate as { directives?: unknown[] } | undefined;
    for (const d of agg?.directives ?? []) {
      const key = typeof d === "string" ? d : JSON.stringify(d);
      if (seenDirective.has(key)) continue;
      seenDirective.add(key);
      directives.push(d);
    }
  }
  renamedSpans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const extractedCount = (extractedFlat.length / 3) | 0;
  const order = new Uint32Array(extractedCount);
  for (let i = 0; i < extractedCount; i++) order[i] = i;
  order.sort((x, y) => {
    const a = x * 3;
    const b = y * 3;
    return (
      extractedFlat[a] - extractedFlat[b] ||
      extractedFlat[a + 1] - extractedFlat[b + 1] ||
      extractedFlat[a + 2] - extractedFlat[b + 2]
    );
  });
  const extractedSpans: number[] = new Array(extractedCount * 3);
  for (let i = 0; i < extractedCount; i++) {
    const from = order[i] * 3;
    const to = i * 3;
    extractedSpans[to] = extractedFlat[from];
    extractedSpans[to + 1] = extractedFlat[from + 1];
    extractedSpans[to + 2] = extractedFlat[from + 2];
  }

  regions.sort((a, b) => {
    const er =
      ((b.entropyRaw as number | undefined) ?? 0) - ((a.entropyRaw as number | undefined) ?? 0);
    if (er !== 0) return er;
    const as = Array.isArray(a.span) ? a.span[0] : 0;
    const bs = Array.isArray(b.span) ? b.span[0] : 0;
    if (as !== bs) return as - bs;
    const ae = Array.isArray(a.span) ? a.span[1] : 0;
    const be = Array.isArray(b.span) ? b.span[1] : 0;
    return ae - be;
  });

  const rep = entries.find((e) => e.file?.sourceOrigin === "original") ?? entries[0];
  const file: PmFileMeta = { ...(rep.file ?? {}), path, sourceOrigin: "original" };

  let outputSum = 0;
  let bundledSum = 0;
  let sawOutput = false;
  let sawBundled = false;
  let anyEstimated = false;
  for (const e of entries) {
    const m = e.file;
    if (!m) continue;
    if (typeof m.outputSize === "number" && Number.isFinite(m.outputSize)) {
      outputSum += m.outputSize;
      sawOutput = true;
    }
    if (typeof m.bundledInputSize === "number" && Number.isFinite(m.bundledInputSize)) {
      bundledSum += m.bundledInputSize;
      sawBundled = true;
    }
    if (m.outputSizeEstimated) anyEstimated = true;
  }
  if (sawBundled) file.bundledInputSize = bundledSum;
  if (sawOutput) {
    file.outputSize = outputSum;
    file.outputSizeEstimated = anyEstimated;
  }
  const denom = sawBundled && bundledSum > 0 ? bundledSum : file.inputSize;
  if (sawOutput && typeof denom === "number" && denom > 0) {
    file.inflationRatio = round4(outputSum / denom);
  } else if (sawOutput) {
    file.inflationRatio = 0;
  }
  return {
    file,
    regions,
    spotlights,
    renamedSpans,
    extractedSpans,
    aggregate: computeAggregate(
      regions,
      spotlights,
      renamedSpans.length,
      directives,
      extractedCount,
    ),
  };
}

export function buildProjectFileTree(files: unknown[]): PmFileEntry[] {
  const byPath = new Map<string, Map<string, PmFileEntry[]>>();
  const pathOrder: string[] = [];
  for (const raw of files) {
    const entry = raw as PmFileEntry | null;
    const file = entry?.file;
    if (!file) continue;
    if (file.sourceOrigin !== "original") continue;
    if (isRuntimeSource(file.path)) continue;
    const clean = cleanSourcePath(file.path);
    const srcKey = file.originalSource ?? "";
    let bySrc = byPath.get(clean);
    if (!bySrc) {
      bySrc = new Map();
      byPath.set(clean, bySrc);
      pathOrder.push(clean);
    }
    const group = bySrc.get(srcKey);
    if (group) group.push(entry);
    else bySrc.set(srcKey, [entry]);
  }

  const out: PmFileEntry[] = [];
  for (const clean of pathOrder) {
    const bySrc = byPath.get(clean) as Map<string, PmFileEntry[]>;
    const variants = [...bySrc.values()];
    variants.forEach((entries, i) => {
      const path = i === 0 ? clean : `${clean}#${i + 1}`;
      const merged = mergeEntries(entries, path);
      if (i > 0 && merged.file) merged.file.pathCollision = true;
      out.push(merged);
    });
  }
  return out;
}

export function writeCombinedProtectionMap(input: WriteCombinedProtectionMapInput): string | null {
  const { buildDir, docs, policy } = input;
  const afterpackDir = input.afterpackDir ?? AFTERPACK_DIR;
  const logger = input.logger ?? DEFAULT_LOGGER;

  if (!policy.protectionMap || docs.length === 0) return null;

  mkdirSync(afterpackDir, { recursive: true });
  const outPath = join(
    afterpackDir,
    input.fileName ?? basename(combinedProtectionMapPath(buildDir)),
  );
  if (policy.protectionMapInProd) {
    warnProtectionMapInProd(outPath, logger);
  } else {
    logger.log(
      `[afterpack] wrote Protection Map -> ${outPath} (gitignored; set protectionMap.enabled:false to skip)`,
    );
  }

  const flat = docs.flatMap((doc) => {
    if (!doc) return [];
    const f = (doc as { files?: unknown }).files;
    return Array.isArray(f) ? f : [doc];
  });
  const files = buildProjectFileTree(flat);
  const envelope = (docs.find((d) => {
    const o = d as { schemaVersion?: unknown; engine?: unknown } | null;
    return !!o && (o.schemaVersion !== undefined || o.engine !== undefined);
  }) ?? {}) as { schemaVersion?: unknown; spanUnits?: unknown; engine?: unknown };
  const { html } = renderProtectionMapHtml(
    {
      schemaVersion: envelope.schemaVersion,
      spanUnits: envelope.spanUnits,
      engine: envelope.engine,
      files,
    },
    { includeLineage: true },
  );
  writeFileSync(outPath, html);
  return outPath;
}

function warnProtectionMapInProd(pmPath: string, logger: Logger): void {
  logger.warn(
    `[afterpack] WARNING: the Protection Map is ENABLED in a PRODUCTION build. ` +
      `This LOCAL file embeds your ORIGINAL SOURCE and surviving-literal samples -- NEVER serve or commit it. ` +
      `Writing it to the gitignored "${pmPath}" instead of alongside the build output.`,
  );
}

export function ensureGitignore(dir: string): string[] {
  const gitignorePath = join(dir, ".gitignore");
  let existing = "";
  if (existsSync(gitignorePath)) {
    try {
      existing = readFileSync(gitignorePath, "utf8");
    } catch {
      existing = "";
    }
  }

  const present = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = GITIGNORE_ENTRIES.filter((e) => !present.has(e));
  if (missing.length === 0) return [];

  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  const block = `${prefix}\n${GITIGNORE_BLOCK_HEADER}\n${missing.join("\n")}\n`;
  writeFileSync(gitignorePath, existing + block);
  return missing;
}

export function warnIfPublicPath(artifactPath: string, logger: Logger = DEFAULT_LOGGER): boolean {
  const segments = artifactPath.split(/[\\/]/).filter(Boolean);
  const hit = segments.find((s) => PUBLIC_SEGMENTS.has(s.toLowerCase()));
  if (hit == null) return false;
  logger.warn(
    `[afterpack] WARNING: writing "${artifactPath}" under a public/served path segment ("${hit}"). ` +
      `Source maps and Protection Maps must NOT be served publicly -- a served obfuscator map is full ` +
      `deobfuscation. Move it out of the served tree or disable the artifact for this build.`,
  );
  return true;
}
