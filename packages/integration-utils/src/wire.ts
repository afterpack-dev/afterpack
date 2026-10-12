import { existsSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isAnchored, matchesPath } from "./glob.js";
import { realPath } from "./home.js";
import type { EngineBatchResult, EngineFileInput, EngineFileResult } from "./pass.js";
import type { CoreConfig } from "./policy.js";
import type { GlobReserved } from "./registry.js";

export const EXTERNAL_WIRE_DIR = "_external";

const DRIVE_PATH = /^[A-Za-z]:[\\/]/;

const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]+:/;

const FILE_URL = /^file:/i;

const PATH_CHARS = "[^\\s\"'`|!?#()<>,;:*\\\\]";

const EMBEDDED_PATH = new RegExp(
  `(^|[^A-Za-z0-9._~/\\\\-])((?:[A-Za-z]:[\\\\/]|/)(?:${PATH_CHARS}|\\\\(?!/))*)`,
  "g",
);

const ESCAPED_PATH = new RegExp(`(^|[^A-Za-z0-9._~/\\\\-])((?:\\\\/${PATH_CHARS}+)+\\\\/?)`, "g");

export class WirePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WirePathError";
  }
}

function toPosix(path: string): string {
  return path.includes("\\") ? path.replaceAll("\\", "/") : path;
}

function lastSegment(path: string): string {
  const parts = toPosix(path)
    .split("/")
    .filter((p) => p !== "");
  return parts[parts.length - 1] ?? "file";
}

function isUnder(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function relativeWithin(file: string, baseDir: string): string | null {
  const rel = relative(resolve(baseDir), resolve(file));
  if (rel === "" || isAbsolute(rel) || DRIVE_PATH.test(rel)) return null;
  if (rel === ".." || rel.startsWith(`..${sep}`)) return null;
  return toPosix(rel);
}

function osUsername(): string | null {
  try {
    return userInfo().username;
  } catch {
    return null;
  }
}

function personalNames(): Set<string> {
  const names = new Set([basename(homedir())]);
  const user = osUsername();
  if (user) names.add(user);
  return names;
}

function safeName(path: string): string {
  const name = lastSegment(path);
  return personalNames().has(name) ? "file" : name;
}

export function toWirePaths(files: readonly string[], baseDir: string): Map<string, string> {
  const wire = new Map<string, string>();
  const taken = new Set<string>();
  const outside: string[] = [];
  for (const file of files) {
    if (wire.has(file)) continue;
    const rel = relativeWithin(file, baseDir);
    if (rel === null || taken.has(rel)) {
      outside.push(file);
      continue;
    }
    wire.set(file, rel);
    taken.add(rel);
  }
  let n = 0;
  for (const file of outside) {
    if (wire.has(file)) continue;
    let label: string;
    do {
      label = `${EXTERNAL_WIRE_DIR}/${n}/${safeName(file)}`;
      n += 1;
    } while (taken.has(label));
    wire.set(file, label);
    taken.add(label);
  }
  return wire;
}

function looksLocal(path: string): boolean {
  return isUnder(path, homedir()) || isUnder(path, tmpdir()) || existsSync(path);
}

function localPathOf(source: string): string | null {
  if (DRIVE_PATH.test(source) || source.startsWith("/") || source.startsWith("\\")) return source;
  if (FILE_URL.test(source)) {
    try {
      return fileURLToPath(source);
    } catch {
      return source.replace(FILE_URL, "").replace(/^\/\/[^/]*/, "") || "/";
    }
  }
  const scheme = URL_SCHEME.exec(source);
  if (!scheme) return null;
  const rest = source.slice(scheme[0].length).replace(/^\/\/[^/]*/, "");
  const drive = rest.replace(/^\/+/, "");
  if (DRIVE_PATH.test(drive)) return drive;
  return rest.startsWith("/") && looksLocal(rest) ? rest : null;
}

interface MapPlace {
  dir: string;
  root: string;
  privateRoots: string[];
  scratchRoots: string[];
  labels: Map<string, string>;
  shipped: string;
}

function bothForms(path: string): string[] {
  return [...new Set([resolve(path), realPath(path)])];
}

function newPlace(dir: string, root: string, labels: Map<string, string>, shipped = ""): MapPlace {
  return {
    dir,
    root,
    privateRoots: [...new Set([homedir(), root].flatMap(bothForms))],
    scratchRoots: bothForms(tmpdir()),
    labels,
    shipped,
  };
}

function isPrivate(path: string, place: MapPlace): boolean {
  if (DRIVE_PATH.test(path) && !isAbsolute(path)) return true;
  if (place.privateRoots.some((r) => isUnder(path, r))) return true;
  return place.scratchRoots.some((r) => isUnder(path, r) && resolve(path) !== resolve(r));
}

function inProject(path: string, place: MapPlace): string | null {
  if (DRIVE_PATH.test(path) && !isAbsolute(path)) return null;
  const real = realPath(path);
  const mapDir = realPath(place.dir);
  const home = realPath(homedir());
  if (!isUnder(real, realPath(place.root))) return null;
  if (isUnder(real, home) && !isUnder(mapDir, home)) return null;
  const rel = relative(mapDir, real);
  if (rel === "" || isAbsolute(rel) || DRIVE_PATH.test(rel)) return null;
  return toPosix(rel);
}

function externalLabel(path: string, place: MapPlace): string {
  const key = resolve(path);
  const known = place.labels.get(key);
  if (known !== undefined) return known;
  const label = `${EXTERNAL_WIRE_DIR}/${place.labels.size}/${safeName(path)}`;
  place.labels.set(key, label);
  return label;
}

function fitLength(target: number, candidate: string, slash: string): string | null {
  const unit = `.${slash}`;
  const room = target - candidate.length;
  for (let a = Math.floor(Math.max(room, 0) / unit.length); a >= 0; a--) {
    const rest = room - a * unit.length;
    if (rest % slash.length !== 0) continue;
    const body = unit.repeat(a) + candidate;
    const extra = rest / slash.length;
    if (extra === 0) return body;
    const at = body.indexOf(slash);
    if (at < 0) continue;
    return body.slice(0, at) + slash.repeat(extra) + body.slice(at);
  }
  return null;
}

function sameLength(original: string, candidates: string[], slash: string): string {
  for (const candidate of candidates) {
    const fitted = fitLength(original.length, candidate, slash);
    if (fitted !== null) return fitted;
  }
  return "_".repeat(original.length);
}

function scrubText(text: string, place: MapPlace, keepLength: boolean): string {
  if (!text.includes("/") && !text.includes("\\")) return text;
  const plain = text.replace(EMBEDDED_PATH, (whole, lead: string, path: string) => {
    if (!isPrivate(path, place) || (keepLength && place.shipped.includes(path))) return whole;
    const name = inProject(path, place) ?? safeName(path);
    return `${lead}${keepLength ? sameLength(path, [name, safeName(path)], "/") : name}`;
  });
  return plain.replace(ESCAPED_PATH, (whole, lead: string, escaped: string) => {
    const path = escaped.replaceAll("\\/", "/");
    if (!isPrivate(path, place) || (keepLength && place.shipped.includes(escaped))) return whole;
    const names = [inProject(path, place) ?? safeName(path), safeName(path)].map((c) =>
      c.replaceAll("/", "\\/"),
    );
    return `${lead}${keepLength ? sameLength(escaped, names, "\\/") : names[0]}`;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function joinRoot(root: string, source: string): string {
  return root.endsWith("/") || root.endsWith("\\") ? `${root}${source}` : `${root}/${source}`;
}

type Table = Map<string, string | null>;

interface MapRestore {
  sources: Table;
  pmPaths: Table;
  contents: Table;
  sourceRoot?: string;
  file?: string;
}

function newRestore(): MapRestore {
  return { sources: new Map(), pmPaths: new Map(), contents: new Map() };
}

function remember(table: Table, wire: string, original: string): void {
  const known = table.get(wire);
  if (known === undefined) table.set(wire, original);
  else if (known !== original) table.set(wire, null);
}

function wireMapObject(
  map: Record<string, unknown>,
  place: MapPlace,
  restore: MapRestore,
  top: boolean,
): { map: Record<string, unknown>; changed: boolean } {
  const out: Record<string, unknown> = { ...map };
  let changed = false;
  const root = typeof map.sourceRoot === "string" ? map.sourceRoot : "";
  const rootIsLocal = root !== "" && localPathOf(root) !== null;
  if (rootIsLocal) {
    delete out.sourceRoot;
    if (top) restore.sourceRoot = root;
    changed = true;
  }
  const sentRoot = rootIsLocal ? "" : root;
  const pmPath = (r: string, s: string) => (r === "" ? s : joinRoot(r, s));
  const taken = new Map<string, string>();
  const claim = (wired: string, original: string, local: string): string => {
    const owner = taken.get(wired);
    if (owner === undefined || owner === original) {
      taken.set(wired, original);
      return wired;
    }
    const label = externalLabel(local, place);
    taken.set(label, original);
    return label;
  };
  if (Array.isArray(map.sources)) {
    out.sources = map.sources.map((source: unknown) => {
      if (typeof source !== "string") return source;
      const rooted =
        rootIsLocal && localPathOf(source) === null && !URL_SCHEME.test(source)
          ? joinRoot(root, source)
          : source;
      const local = localPathOf(rooted);
      let wired: string;
      if (local === null) {
        const scrubbed = scrubText(rooted, place, false);
        if (scrubbed === source) {
          taken.set(source, source);
          return source;
        }
        wired = claim(scrubbed, source, rooted);
      } else {
        const rel = inProject(local, place);
        wired = claim(rel ?? externalLabel(local, place), source, local);
      }
      changed = true;
      remember(restore.sources, wired, source);
      remember(restore.pmPaths, pmPath(sentRoot, wired), pmPath(root, source));
      return wired;
    });
  }
  if (typeof map.file === "string" && localPathOf(map.file) !== null) {
    if (top) restore.file = map.file;
    out.file = safeName(map.file);
    changed = true;
  }
  if (Array.isArray(map.sourcesContent)) {
    out.sourcesContent = map.sourcesContent.map((content: unknown) => {
      if (typeof content !== "string") return content;
      const scrubbed = scrubText(content, place, true);
      if (scrubbed === content) return content;
      changed = true;
      remember(restore.contents, scrubbed, content);
      return scrubbed;
    });
  }
  if (Array.isArray(map.sections)) {
    out.sections = map.sections.map((section: unknown) => {
      if (!isRecord(section) || !isRecord(section.map)) return section;
      const nested = wireMapObject(section.map, place, restore, false);
      if (!nested.changed) return section;
      changed = true;
      return { ...section, map: nested.map };
    });
  }
  return { map: out, changed };
}

function wireSourceMapWithRestore(
  json: string,
  place: MapPlace,
): { json: string | undefined; restore: MapRestore } {
  const restore = newRestore();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { json: undefined, restore };
  }
  if (!isRecord(parsed)) return { json: undefined, restore };
  const { map, changed } = wireMapObject(parsed, place, restore, true);
  return { json: changed ? JSON.stringify(map) : json, restore };
}

export function wireSourceMap(
  json: string,
  mapDir: string,
  rootDir: string = mapDir,
): string | undefined {
  return wireSourceMapWithRestore(json, newPlace(mapDir, rootDir, new Map())).json;
}

export function scrubLocalPaths(text: string, mapDir: string, rootDir: string = mapDir): string {
  return scrubText(text, newPlace(mapDir, rootDir, new Map()), true);
}

function lookup(table: Table, value: string): string {
  return table.get(value) ?? value;
}

interface FileRestore {
  map: MapRestore;
  wire: string;
  local: string;
}

function restoreMapObject(
  map: Record<string, unknown>,
  ctx: FileRestore,
  top: boolean,
): { map: Record<string, unknown>; changed: boolean } {
  let changed = false;
  const out: Record<string, unknown> = { ...map };
  if (Array.isArray(map.sources)) {
    out.sources = map.sources.map((entry: unknown) => {
      if (typeof entry !== "string") return entry;
      const back = entry === ctx.wire ? ctx.local : lookup(ctx.map.sources, entry);
      if (back !== entry) changed = true;
      return back;
    });
  }
  if (Array.isArray(map.sourcesContent)) {
    out.sourcesContent = map.sourcesContent.map((entry: unknown) => {
      if (typeof entry !== "string") return entry;
      const back = lookup(ctx.map.contents, entry);
      if (back !== entry) changed = true;
      return back;
    });
  }
  if (top && ctx.map.sourceRoot !== undefined && !map.sourceRoot) {
    const root = ctx.map.sourceRoot;
    const entries = Object.entries(out).filter(([key]) => key !== "sourceRoot");
    const at = "sourceRoot" in map ? Object.keys(map).indexOf("sourceRoot") : -1;
    const after = entries.findIndex(([key]) => key === "sources");
    const index = at >= 0 ? at : after >= 0 ? after + 1 : entries.length;
    entries.splice(index, 0, ["sourceRoot", root]);
    for (const key of Object.keys(out)) delete out[key];
    Object.assign(out, Object.fromEntries(entries));
    changed = true;
  }
  if (top && ctx.map.file !== undefined && typeof map.file === "string") {
    out.file = ctx.map.file;
    changed = true;
  }
  if (Array.isArray(map.sections)) {
    out.sections = map.sections.map((section: unknown) => {
      if (!isRecord(section) || !isRecord(section.map)) return section;
      const nested = restoreMapObject(section.map, ctx, false);
      if (!nested.changed) return section;
      changed = true;
      return { ...section, map: nested.map };
    });
  }
  return { map: out, changed };
}

function restoreSourceMap(json: string, ctx: FileRestore): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return json;
  }
  if (!isRecord(parsed)) return json;
  const { map, changed } = restoreMapObject(parsed, ctx, true);
  return changed ? JSON.stringify(map) : json;
}

function restoredSize(size: unknown, wired: string, original: string): unknown {
  if (typeof size !== "number") return size;
  if (size === Buffer.byteLength(wired)) return Buffer.byteLength(original);
  if (size === wired.length) return original.length;
  return size;
}

function restoreProtectionMap<T>(doc: T, ctx: FileRestore): T {
  if (!isRecord(doc) || !Array.isArray(doc.files)) return doc;
  return {
    ...doc,
    files: doc.files.map((entry: unknown) => {
      if (!isRecord(entry) || !isRecord(entry.file)) return entry;
      const file = entry.file;
      const next: Record<string, unknown> = { ...file };
      if (typeof file.path === "string") {
        next.path = file.path === ctx.wire ? ctx.local : lookup(ctx.map.pmPaths, file.path);
      }
      if (typeof file.originalSource === "string") {
        const original = lookup(ctx.map.contents, file.originalSource);
        if (original !== file.originalSource) {
          next.originalSource = original;
          next.inputSize = restoredSize(file.inputSize, file.originalSource, original);
        }
      }
      const same = Object.keys(next).every((k) => next[k] === file[k]);
      return same ? entry : { ...entry, file: next };
    }),
  } as T;
}

function wireGlob(pattern: string, pairs: readonly (readonly [string, string])[]): string[] {
  let equivalent = true;
  const matched: string[] = [];
  for (const [local, wire] of pairs) {
    const hit = matchesPath(pattern, local);
    if (hit !== matchesPath(pattern, wire)) equivalent = false;
    if (hit) matched.push(wire);
  }
  if (!isAnchored(pattern) && equivalent && matched.length > 0) return [pattern];
  return matched.map((wire) => `/${wire}`);
}

function anyMatch(patterns: readonly string[], path: string): boolean {
  return patterns.some((p) => matchesPath(p, path));
}

function reservedNames(entries: readonly (string | GlobReserved)[], path: string): string {
  const names = entries.flatMap((e) =>
    typeof e === "string" ? [] : matchesPath(e.glob, path) ? e.names : [],
  );
  return [...new Set(names)].sort().join("\n");
}

function verifyTranslation(
  config: CoreConfig,
  out: CoreConfig,
  pairs: readonly (readonly [string, string])[],
): void {
  const exclude = config.paths?.exclude ?? [];
  const sentExclude = out.paths?.exclude ?? [];
  const reserved = config.identifiers?.reserved ?? [];
  const sentReserved = out.identifiers?.reserved ?? [];
  for (const [local, wire] of pairs) {
    if (anyMatch(exclude, local) !== anyMatch(sentExclude, wire)) {
      throw new WirePathError(
        `could not send \`paths.exclude\` to the engine without changing which files it ` +
          `selects: ${wire} would be ${anyMatch(exclude, local) ? "protected" : "left unprotected"}. ` +
          "Rename the file or write the pattern so it does not depend on glob characters in file names.",
      );
    }
    if (reservedNames(reserved, local) !== reservedNames(sentReserved, wire)) {
      throw new WirePathError(
        "could not send `identifiers.reserved` to the engine without changing which files its " +
          `globs select: ${wire} would keep a different set of names. Rename the file or write ` +
          "the glob so it does not depend on glob characters in file names.",
      );
    }
  }
}

function translateConfig(
  config: CoreConfig,
  wirePaths: ReadonlyMap<string, string>,
): { config: CoreConfig; origins: Map<string, string> } {
  const exclude = config.paths?.exclude;
  const reserved = config.identifiers?.reserved;
  const origins = new Map<string, string>();
  if (exclude === undefined && reserved === undefined) return { config, origins };
  const pairs = [...wirePaths.entries()];
  const translate = (pattern: string): string[] => {
    const patterns = wireGlob(pattern, pairs);
    for (const p of patterns) if (!origins.has(p)) origins.set(p, pattern);
    return patterns;
  };
  const out: CoreConfig = { ...config };
  if (exclude !== undefined) {
    out.paths = {
      ...config.paths,
      exclude: [...new Set(exclude.flatMap((pattern) => translate(pattern)))],
    };
  }
  if (reserved !== undefined) {
    out.identifiers = {
      ...config.identifiers,
      reserved: reserved.flatMap((entry): (string | GlobReserved)[] =>
        typeof entry === "string"
          ? [entry]
          : translate(entry.glob).map((glob) => ({ ...entry, glob })),
      ),
    };
  }
  verifyTranslation(config, out, pairs);
  return { config: out, origins };
}

export function wireEngineConfig(
  config: CoreConfig,
  wirePaths: ReadonlyMap<string, string>,
): CoreConfig {
  return translateConfig(config, wirePaths).config;
}

export interface WireBatch {
  inputs: EngineFileInput[];
  config: CoreConfig;
  toLocal(batch: EngineBatchResult): EngineBatchResult;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function localMessage(message: string, wire: string, local: string, origins: Map<string, string>) {
  let out = message;
  for (const [sent, original] of origins) {
    if (sent !== original) out = out.split(`"${sent}"`).join(`"${original}"`);
  }
  const bounded = new RegExp(
    `(^|[\\s"'\`(\\[])${escapeRegExp(wire)}(?=$|[\\s"'\`)\\]:,;]|\\.(?:\\s|$))`,
    "g",
  );
  return out.replace(bounded, (_m, lead: string) => `${lead}${local}`);
}

function localDiagnostics(
  diagnostics: unknown,
  localPaths: ReadonlyMap<string, string>,
  wire: string,
  local: string,
  origins: Map<string, string>,
): EngineFileResult["diagnostics"] {
  if (!Array.isArray(diagnostics)) return diagnostics as EngineFileResult["diagnostics"];
  return diagnostics.map((d) => {
    if (!isRecord(d)) return d;
    const next: Record<string, unknown> = { ...d };
    if (typeof d.file === "string") next.file = localPaths.get(d.file) ?? d.file;
    if (typeof d.message === "string") next.message = localMessage(d.message, wire, local, origins);
    return next.file === d.file && next.message === d.message ? d : next;
  }) as EngineFileResult["diagnostics"];
}

export function prepareWireBatch(
  inputs: readonly EngineFileInput[],
  config: CoreConfig,
  baseDir: string,
  rootDir: string = baseDir,
): WireBatch {
  const wirePaths = toWirePaths(
    inputs.map((i) => i.path),
    baseDir,
  );
  const localPaths = new Map([...wirePaths].map(([local, wire]) => [wire, local]));
  const translated = translateConfig(config, wirePaths);
  const restores = new Map<string, MapRestore>();
  const labels = new Map<string, string>();
  const wiredInputs = inputs.map((input) => {
    const path = wirePaths.get(input.path) ?? input.path;
    const wired: EngineFileInput = { ...input, path };
    if (input.sourceMap !== undefined) {
      const place = newPlace(dirname(resolve(input.path)), rootDir, labels, input.source);
      const map = wireSourceMapWithRestore(input.sourceMap, place);
      restores.set(path, map.restore);
      if (map.json === undefined) delete wired.sourceMap;
      else wired.sourceMap = map.json;
    }
    return wired;
  });
  return {
    inputs: wiredInputs,
    config: translated.config,
    toLocal: (batch) => ({
      ...batch,
      files: batch.files.map((f) => {
        const local = localPaths.get(f.path);
        if (local === undefined) return f;
        const ctx: FileRestore = { map: restores.get(f.path) ?? newRestore(), wire: f.path, local };
        return {
          ...f,
          path: local,
          ...(f.diagnostics === undefined
            ? {}
            : {
                diagnostics: localDiagnostics(
                  f.diagnostics,
                  localPaths,
                  f.path,
                  local,
                  translated.origins,
                ),
              }),
          ...(typeof f.sourceMap === "string"
            ? { sourceMap: restoreSourceMap(f.sourceMap, ctx) }
            : {}),
          ...(f.protectionMap == null
            ? {}
            : { protectionMap: restoreProtectionMap(f.protectionMap, ctx) }),
        };
      }),
    }),
  };
}
