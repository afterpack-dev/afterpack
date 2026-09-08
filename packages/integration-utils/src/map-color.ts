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

function lineByteStarts(lines: string[]): number[] {
  const starts = new Array<number>(lines.length);
  let acc = 0;
  for (let i = 0; i < lines.length; i++) {
    starts[i] = acc;
    acc += utf8Len(lines[i]) + 1;
  }
  return starts;
}

function norm(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/[?#].*$/, "")
    .replace(/^(?:\.\.?\/)+/, "");
}

function pathsMatch(id: string, source: string): boolean {
  const a = norm(id);
  const b = norm(source);
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

export type ColorRegionsWarn = (message: string) => void;

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

  const chunkBytes = utf8Len(chunkCode);

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

  const lines = chunkCode.split("\n");
  const lineStarts = lineByteStarts(lines);
  const posToByte = (line: number, col: number): number => {
    if (line < 0 || line >= lines.length) return chunkBytes;
    const l = lines[line];
    return lineStarts[line] + utf8Len(l.slice(0, Math.min(col, l.length)));
  };

  const out: RegionConfig[] = [];
  const located: { mod: CapturedModule; srcIdx: number }[] = [];
  for (const mod of withDirectives) {
    const srcIdx =
      mod.srcIndex != null && mod.srcIndex >= 0 && mod.srcIndex < sources.length
        ? mod.srcIndex
        : sources.findIndex((s) => s != null && pathsMatch(mod.id, s));
    if (srcIdx < 0) {
      warn(
        `DIAG_DIRECTIVE_COVERAGE_UNVERIFIED: skipped ${mod.directives.length} @afterpack ` +
          `directive(s) — the bundler placed \`${mod.id}\` in this chunk but its source map ` +
          "does not list it, so they cannot be placed in the chunk's bytes.",
      );
      continue;
    }
    located.push({ mod, srcIdx });
    for (const d of mod.directives) {
      const start = charToLineCol(mod.source, d.charStart);
      const end = charToLineCol(mod.source, d.charEnd);
      const ranges = coverGenerated(segsByLine, lines, srcIdx, start, end, posToByte);
      for (const [s, e] of ranges) out.push({ ...d.region, start: s, end: e });
    }
  }
  if (out.length === 0 && located.length > 0) {
    const segCountBySrc = new Map<number, number>();
    for (const lineSegs of segsByLine) {
      for (const seg of lineSegs) {
        if (seg.length < 4) continue;
        const idx = seg[1] as number;
        segCountBySrc.set(idx, (segCountBySrc.get(idx) ?? 0) + 1);
      }
    }
    for (const { mod, srcIdx } of located) {
      if ((segCountBySrc.get(srcIdx) ?? 0) === 0) {
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

function coverGenerated(
  segsByLine: SourceMapSegment[][],
  lines: string[],
  srcIdx: number,
  start: { line: number; col: number },
  end: { line: number; col: number },
  posToByte: (line: number, col: number) => number,
): Array<[number, number]> {
  const inSpan = (line: number, col: number): boolean => {
    const afterStart = line > start.line || (line === start.line && col >= start.col);
    const beforeEnd = line < end.line || (line === end.line && col < end.col);
    return afterStart && beforeEnd;
  };

  const ranges: Array<[number, number]> = [];
  for (let gl = 0; gl < segsByLine.length; gl++) {
    const segs = segsByLine[gl];
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (seg.length < 4) continue;
      const genCol = seg[0];
      const sIdx = seg[1] as number;
      const srcLine = seg[2] as number;
      const srcCol = seg[3] as number;
      if (sIdx !== srcIdx || !inSpan(srcLine, srcCol)) continue;
      const nextCol = i + 1 < segs.length ? segs[i + 1][0] : (lines[gl]?.length ?? genCol);
      const s = posToByte(gl, genCol);
      const e = posToByte(gl, nextCol);
      if (e > s) ranges.push([s, e]);
    }
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
