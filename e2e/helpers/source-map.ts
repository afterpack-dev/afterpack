import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { expect } from "@playwright/test";
import type { Fixture, FixtureTarget } from "./registry.js";

const JS_OUTPUT = /\.(?:js|mjs|cjs)$/;
const SOURCE_MAPPING_URL = /\/\/[#@]\s*sourceMappingURL=([^\s'"]+)\s*$/m;
const DATA_URI = /^data:application\/json[^,]*;base64,(.*)$/;
const BASE64_VLQ = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export interface SourceMapExpectation {
  minMaps?: number;
}

export interface MappedPosition {
  generatedLine: number;
  generatedColumn: number;
  sourceIndex: number;
  sourceLine: number;
  sourceColumn: number;
}

interface RawSourceMap {
  version?: unknown;
  sources?: unknown;
  sourcesContent?: unknown;
  sourceRoot?: unknown;
  mappings?: unknown;
  sections?: unknown;
}

function decodeVlq(field: string): number[] {
  const values: number[] = [];
  let value = 0;
  let shift = 0;
  for (const character of field) {
    const digit = BASE64_VLQ.indexOf(character);
    if (digit < 0) throw new Error(`not base64 VLQ: ${JSON.stringify(character)}`);
    value += (digit & 31) * 2 ** shift;
    if ((digit & 32) !== 0) {
      shift += 5;
      continue;
    }
    const negative = (value & 1) === 1;
    value = Math.floor(value / 2);
    values.push(negative ? -value : value);
    value = 0;
    shift = 0;
  }
  if (shift !== 0) throw new Error("truncated base64 VLQ field");
  return values;
}

export function decodeFirstSegments(mappings: string, max: number): MappedPosition[] {
  const out: MappedPosition[] = [];
  let sourceIndex = 0;
  let sourceLine = 0;
  let sourceColumn = 0;
  const lines = mappings.split(";");
  for (let generatedLine = 0; generatedLine < lines.length; generatedLine++) {
    let generatedColumn = 0;
    for (const field of lines[generatedLine].split(",")) {
      if (field === "") continue;
      const deltas = decodeVlq(field);
      generatedColumn += deltas[0];
      if (deltas.length < 4) continue;
      sourceIndex += deltas[1];
      sourceLine += deltas[2];
      sourceColumn += deltas[3];
      out.push({ generatedLine, generatedColumn, sourceIndex, sourceLine, sourceColumn });
      if (out.length >= max) return out;
    }
  }
  return out;
}

function jsOutputs(targets: readonly FixtureTarget[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const isDirectory = entry.isDirectory() || (!entry.isFile() && statSync(full).isDirectory());
      if (isDirectory) walk(full);
      else if (JS_OUTPUT.test(entry.name)) out.push(full);
    }
  };
  for (const target of targets) {
    if (existsSync(target.path)) walk(target.path);
  }
  return out.sort();
}

interface LocatedMap {
  json: string;
  origin: string;
  baseDir: string;
}

function locateMap(jsPath: string): LocatedMap | null {
  const sibling = `${jsPath}.map`;
  if (existsSync(sibling)) {
    return { json: readFileSync(sibling, "utf8"), origin: sibling, baseDir: dirname(sibling) };
  }
  const declared = SOURCE_MAPPING_URL.exec(readFileSync(jsPath, "utf8"));
  if (!declared) return null;
  const url = declared[1];
  const inline = DATA_URI.exec(url);
  if (inline) {
    return {
      json: Buffer.from(inline[1], "base64").toString("utf8"),
      origin: `${jsPath} (inline sourceMappingURL)`,
      baseDir: dirname(jsPath),
    };
  }
  const referenced = resolve(dirname(jsPath), url);
  if (!existsSync(referenced)) {
    throw new Error(`${jsPath} points at a sourceMappingURL that does not exist: ${url}`);
  }
  return {
    json: readFileSync(referenced, "utf8"),
    origin: referenced,
    baseDir: dirname(referenced),
  };
}

function isPlaceholder(map: RawSourceMap): boolean {
  const sources = Array.isArray(map.sources) ? map.sources : [];
  const sections = Array.isArray(map.sections) ? map.sections : null;
  const mappings = typeof map.mappings === "string" ? map.mappings : "";
  if (sections !== null) return sections.length === 0 && sources.length === 0;
  return sources.length === 0 && mappings === "";
}

function assertMapping(map: RawSourceMap, where: string, baseDir: string): number {
  expect(map.version, `${where} is not a v3 source map`).toBe(3);
  if (isPlaceholder(map)) return 0;

  if (Array.isArray(map.sections)) {
    let validated = 0;
    map.sections.forEach((raw, index) => {
      const section = raw as { map?: unknown } | null;
      expect(
        section !== null && typeof section === "object" && typeof section.map === "object",
        `${where} section ${index} carries no embedded map`,
      ).toBe(true);
      validated += assertMapping(
        (section as { map: RawSourceMap }).map,
        `${where} section ${index}`,
        baseDir,
      );
    });
    expect(validated, `${where} is an index map whose sections map nothing`).toBeGreaterThan(0);
    return validated;
  }

  expect(Array.isArray(map.sources) && map.sources.length > 0, `${where} names no sources`).toBe(
    true,
  );
  const sources = map.sources as (string | null)[];

  expect(
    typeof map.mappings === "string" && map.mappings.length > 0,
    `${where} carries no mappings`,
  ).toBe(true);

  const positions = decodeFirstSegments(map.mappings as string, 64);
  expect(positions.length, `${where} decodes to no mapped position at all`).toBeGreaterThan(0);

  const contents = Array.isArray(map.sourcesContent)
    ? (map.sourcesContent as (string | null)[])
    : [];
  const sourceRoot = typeof map.sourceRoot === "string" ? map.sourceRoot : "";
  const anchored = positions.some((position) => {
    const source = sources[position.sourceIndex];
    if (source == null || position.sourceLine < 0 || position.sourceColumn < 0) return false;
    const content = contents[position.sourceIndex];
    if (typeof content === "string" && content.length > 0) return true;
    return existsSync(resolve(baseDir, sourceRoot, source));
  });
  expect(
    anchored,
    `${where}: no mapped position lands in a source that either carries sourcesContent or ` +
      "resolves on disk next to the map",
  ).toBe(true);
  return 1;
}

function assertMap(located: LocatedMap, label: string): number {
  let parsed: RawSourceMap;
  try {
    parsed = JSON.parse(located.json) as RawSourceMap;
  } catch (error) {
    throw new Error(
      `${label}: ${located.origin} is not valid JSON — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return assertMapping(parsed, `${label}: ${located.origin}`, located.baseDir);
}

export function expectSourceMap(app: Fixture, expected: SourceMapExpectation = {}): void {
  const outputs = jsOutputs(app.targets);
  expect(
    outputs.length,
    `${app.name}: no JavaScript found under its build targets`,
  ).toBeGreaterThan(0);

  let validated = 0;
  let placeholders = 0;
  for (const jsPath of outputs) {
    const located = locateMap(jsPath);
    if (!located) continue;
    const mapped = assertMap(located, `${app.name} ${relative(app.dir, jsPath)}`);
    if (mapped === 0) placeholders += 1;
    else validated += mapped;
  }

  expect(
    validated,
    `${app.name}: expected at least ${expected.minMaps ?? 0} usable source map(s) beside its ` +
      `obfuscated output, validated ${validated} (${placeholders} empty placeholder map(s))`,
  ).toBeGreaterThanOrEqual(expected.minMaps ?? 0);
}
