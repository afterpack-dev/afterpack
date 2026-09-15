import { decode, type SourceMapSegment } from "@jridgewell/sourcemap-codec";
import type { CapturedDirective } from "./directives.js";
import type { RegionConfig } from "./policy.js";

export interface DecodedSourceMap {
  sources: (string | null)[];
  mappings: string;
  sourcesContent?: (string | null)[];
}

export interface CapturedModule {
  id: string;
  source: string;
  directives: CapturedDirective[];
  renameGlobals?: boolean;
  srcIndex?: number;
}

const UTF8 = new TextEncoder();
const utf8Len = (s: string): number => UTF8.encode(s).length;

const NON_ASCII = /[\u0080-\uFFFF]/;

const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;

function charToByteTable(line: string): number[] {
  const table = new Array<number>(line.length + 1);
  let bytes = 0;
  let i = 0;
  while (i < line.length) {
    table[i] = bytes;
    const code = line.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
      i += 1;
      continue;
    }
    if (code < 0x800) {
      bytes += 2;
      i += 1;
      continue;
    }
    if (code >= HIGH_SURROGATE_START && code <= HIGH_SURROGATE_END && i + 1 < line.length) {
      const low = line.charCodeAt(i + 1);
      if (low >= LOW_SURROGATE_START && low <= LOW_SURROGATE_END) {
        table[i + 1] = bytes + 3;
        bytes += 4;
        i += 2;
        continue;
      }
    }
    bytes += 3;
    i += 1;
  }
  table[line.length] = bytes;
  return table;
}

class ChunkByteIndex {
  private readonly starts: number[];
  private readonly ascii: boolean[];
  private readonly tables: (number[] | null)[];
  readonly totalBytes: number;

  constructor(private readonly lines: string[]) {
    this.starts = new Array<number>(lines.length);
    this.ascii = new Array<boolean>(lines.length);
    this.tables = new Array<number[] | null>(lines.length).fill(null);
    let acc = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      this.starts[i] = acc;
      const isAscii = !NON_ASCII.test(line);
      this.ascii[i] = isAscii;
      acc += (isAscii ? line.length : utf8Len(line)) + 1;
    }
    this.totalBytes = lines.length === 0 ? 0 : acc - 1;
  }

  byteOf(line: number, col: number): number {
    if (line < 0 || line >= this.lines.length) return this.totalBytes;
    const text = this.lines[line];
    const clamped = col < 0 ? 0 : col < text.length ? col : text.length;
    if (this.ascii[line]) return this.starts[line] + clamped;
    let table = this.tables[line];
    if (table === null) {
      table = charToByteTable(text);
      this.tables[line] = table;
    }
    return this.starts[line] + table[clamped];
  }
}

function charToLineCol(source: string, charIndex: number): { line: number; col: number } {
  let line = 0;
  let lineStart = 0;
  const stop = Math.min(charIndex, source.length);
  for (let i = 0; i < stop; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, col: charIndex - lineStart };
}

function norm(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/[?#].*$/, "")
    .replace(/^(?:\.\.?\/)+/, "");
}

function normEq(a: string, b: string): boolean {
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

type ColorRegionsWarn = (message: string) => void;

const DEFAULT_WARN: ColorRegionsWarn = (message) => {
  console.warn(`[afterpack] ${message}`);
};

const countDirectives = (modules: readonly CapturedModule[]): number =>
  modules.reduce((n, m) => n + m.directives.length, 0);

export function colorRegions(
  chunkCode: string,
  map: DecodedSourceMap | null,
  modules: readonly CapturedModule[],
  warn: ColorRegionsWarn = DEFAULT_WARN,
): RegionConfig[] {
  const withDirectives = modules.filter((m) => m.directives.length > 0);
  if (withDirectives.length === 0) return [];

  let segsByLine: SourceMapSegment[][] | null = null;
  if (map && typeof map.mappings === "string") {
    try {
      segsByLine = decode(map.mappings);
    } catch {
      segsByLine = null;
    }
  }
  if (!segsByLine || !map) {
    warn(
      `DIAG_DIRECTIVE_COVERAGE_UNVERIFIED: skipped ${countDirectives(withDirectives)} @afterpack ` +
        `directive(s) from ${withDirectives.length} module(s) — this chunk has no decodable ` +
        "source map, so they cannot be placed in its bytes.",
    );
    return [];
  }
  const sources = map.sources ?? [];
  const normSources = sources.map((s) => (s == null ? null : norm(s)));

  const lines = chunkCode.split("\n");
  const index = new ChunkByteIndex(lines);
  const bySource = bucketBySource(segsByLine, lines);

  const out: RegionConfig[] = [];
  const located: { mod: CapturedModule; srcIdx: number }[] = [];
  for (const mod of withDirectives) {
    let srcIdx =
      mod.srcIndex != null && mod.srcIndex >= 0 && mod.srcIndex < sources.length
        ? mod.srcIndex
        : -1;
    if (srcIdx < 0) {
      const normId = norm(mod.id);
      srcIdx = normSources.findIndex((ns) => ns != null && normEq(normId, ns));
    }
    if (srcIdx < 0) {
      warn(
        `DIAG_DIRECTIVE_COVERAGE_UNVERIFIED: skipped ${mod.directives.length} @afterpack ` +
          `directive(s) — the bundler placed \`${mod.id}\` in this chunk but its source map ` +
          "does not list it, so they cannot be placed in the chunk's bytes.",
      );
      continue;
    }
    located.push({ mod, srcIdx });
    const segments = bySource.get(srcIdx) ?? [];
    for (const d of mod.directives) {
      const start = charToLineCol(mod.source, d.charStart);
      const end = charToLineCol(mod.source, d.charEnd);
      const ranges = coverGenerated(segments, start, end, index);
      for (const [s, e] of ranges) out.push({ ...d.region, start: s, end: e });
    }
  }
  if (out.length === 0 && located.length > 0) {
    for (const { mod, srcIdx } of located) {
      if ((bySource.get(srcIdx)?.length ?? 0) === 0) {
        warn(
          `DIAG_DIRECTIVE_SOURCE_UNRESOLVED: \`${mod.id}\` carries ${mod.directives.length} ` +
            "@afterpack directive(s) but this chunk's source map has NO mapping segment anywhere " +
            "for that source, so its interior cannot be resolved at all — the directive(s) were " +
            "NOT applied. This is a source-map coverage gap, not tree-shaking.",
        );
      } else {
        warn(
          `DIAG_DIRECTIVE_TARGET_ELIMINATED: located \`${mod.id}\` carrying ` +
            `${mod.directives.length} @afterpack directive(s) in this chunk's source map but ` +
            "colored 0 ranges for it — the marked code was tree-shaken, or the map's original " +
            "coordinates do not line up with the captured source.",
        );
      }
    }
  }
  return out;
}

interface GeneratedSegment {
  genLine: number;
  genCol: number;
  endCol: number;
  srcLine: number;
  srcCol: number;
}

function bucketBySource(
  segsByLine: SourceMapSegment[][],
  lines: string[],
): Map<number, GeneratedSegment[]> {
  const bySource = new Map<number, GeneratedSegment[]>();
  for (let gl = 0; gl < segsByLine.length; gl++) {
    const segs = segsByLine[gl];
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (seg.length < 4) continue;
      const genCol = seg[0];
      const srcIdx = seg[1] as number;
      let bucket = bySource.get(srcIdx);
      if (bucket === undefined) {
        bucket = [];
        bySource.set(srcIdx, bucket);
      }
      bucket.push({
        genLine: gl,
        genCol,
        endCol: i + 1 < segs.length ? segs[i + 1][0] : (lines[gl]?.length ?? genCol),
        srcLine: seg[2] as number,
        srcCol: seg[3] as number,
      });
    }
  }
  return bySource;
}

function coverGenerated(
  segments: readonly GeneratedSegment[],
  start: { line: number; col: number },
  end: { line: number; col: number },
  index: ChunkByteIndex,
): Array<[number, number]> {
  const inSpan = (line: number, col: number): boolean => {
    const afterStart = line > start.line || (line === start.line && col >= start.col);
    const beforeEnd = line < end.line || (line === end.line && col < end.col);
    return afterStart && beforeEnd;
  };

  const ranges: Array<[number, number]> = [];
  for (const seg of segments) {
    if (!inSpan(seg.srcLine, seg.srcCol)) continue;
    const s = index.byteOf(seg.genLine, seg.genCol);
    const e = index.byteOf(seg.genLine, seg.endCol);
    if (e > s) ranges.push([s, e]);
  }

  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const [a, b] of ranges) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}
