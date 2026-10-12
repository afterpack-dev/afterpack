import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isAnchored, matchesPath } from "./glob.js";
import { realPath } from "./home.js";
import type { EngineBatchResult, EngineFileInput, EngineFileResult } from "./pass.js";
import type { CoreConfig } from "./policy.js";
import type { GlobReserved } from "./registry.js";

export const EXTERNAL_WIRE_DIR = "_external";

const DRIVE_PATH = /^[A-Za-z]:[\\/]/;

const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]+:/;

const FILE_URL = /^fi(?:)le:/i;

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
      label = `${EXTERNAL_WIRE_DIR}/${n}/${lastSegment(file)}`;
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
}

function privateRootsOf(root: string): string[] {
  const roots = [homedir(), tmpdir(), root];
  return [...new Set(roots.flatMap((r) => [resolve(r), realPath(r)]))];
}

const EMBEDDED_PATH = /(^|[^A-Za-z0-9._~/-])((?:[A-Za-z]:[\\/]|\/)[^\s"'`|!?#()<>,;:*]+)/g;

function scrubEmbedded(text: string, place: MapPlace): string {
  if (!text.includes("/") && !text.includes("\\")) return text;
  return text.replace(EMBEDDED_PATH, (whole, lead: string, path: string) =>
    place.privateRoots.some((r) => isUnder(path, r) && resolve(path) !== resolve(r))
      ? `${lead}${relativeSource(path, place)}`
      : whole,
  );
}

function relativeSource(path: string, place: MapPlace): string {
  if (DRIVE_PATH.test(path) && !isAbsolute(path)) return lastSegment(path);
  const real = realPath(path);
  const mapDir = realPath(place.dir);
  const home = realPath(homedir());
  if (!isUnder(real, realPath(place.root))) return lastSegment(path);
  if (isUnder(real, home) && !isUnder(mapDir, home)) return lastSegment(path);
  const rel = relative(mapDir, real);
  if (rel === "" || isAbsolute(rel) || DRIVE_PATH.test(rel)) return lastSegment(path);
  return toPosix(rel);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function joinRoot(root: string, source: string): string {
  return root.endsWith("/") || root.endsWith("\\") ? `${root}${source}` : `${root}/${source}`;
}

type RestoreTable = Map<string, string | null>;

function remember(restore: RestoreTable, wire: string, original: string): void {
  const known = restore.get(wire);
  if (known === undefined) restore.set(wire, original);
  else if (known !== original) restore.set(wire, null);
}

function wireMapObject(
  map: Record<string, unknown>,
  place: MapPlace,
  restore: RestoreTable,
): { map: Record<string, unknown>; changed: boolean } {
  const out: Record<string, unknown> = { ...map };
  let changed = false;
  const root = typeof map.sourceRoot === "string" ? map.sourceRoot : "";
  const rootIsLocal = root !== "" && localPathOf(root) !== null;
  if (rootIsLocal) {
    delete out.sourceRoot;
    changed = true;
  }
  if (Array.isArray(map.sources)) {
    out.sources = map.sources.map((source: unknown) => {
      if (typeof source !== "string") return source;
      const rooted =
        rootIsLocal && localPathOf(source) === null && !URL_SCHEME.test(source)
          ? joinRoot(root, source)
          : source;
      const local = localPathOf(rooted);
      if (local === null) {
        const scrubbed = scrubEmbedded(rooted, place);
        if (scrubbed === rooted) return rooted;
        changed = true;
        remember(restore, scrubbed, rooted);
        return scrubbed;
      }
      changed = true;
      const wired = relativeSource(local, place);
      remember(restore, wired, rooted);
      if (root !== "" && !rootIsLocal) {
        remember(restore, joinRoot(root, wired), joinRoot(root, rooted));
      }
      return wired;
    });
  }
  if (typeof map.file === "string" && localPathOf(map.file) !== null) {
    out.file = lastSegment(map.file);
    changed = true;
  }
  if (Array.isArray(map.sourcesContent)) {
    out.sourcesContent = map.sourcesContent.map((content: unknown) => {
      if (typeof content !== "string") return content;
      const scrubbed = scrubEmbedded(content, place);
      if (scrubbed === content) return content;
      changed = true;
      remember(restore, scrubbed, content);
      return scrubbed;
    });
  }
  if (Array.isArray(map.sections)) {
    out.sections = map.sections.map((section: unknown) => {
      if (!isRecord(section) || !isRecord(section.map)) return section;
      const nested = wireMapObject(section.map, place, restore);
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
): { json: string | undefined; restore: RestoreTable } {
  const restore: RestoreTable = new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { json: undefined, restore };
  }
  if (!isRecord(parsed)) return { json: undefined, restore };
  const { map, changed } = wireMapObject(parsed, place, restore);
  return { json: changed ? JSON.stringify(map) : json, restore };
}

export function wireSourceMap(
  json: string,
  mapDir: string,
  rootDir: string = mapDir,
): string | undefined {
  return wireSourceMapWithRestore(json, {
    dir: mapDir,
    root: rootDir,
    privateRoots: privateRootsOf(rootDir),
  }).json;
}

function restored(restore: RestoreTable, path: string): string {
  return restore.get(path) ?? path;
}

function restoreMapObject(
  map: Record<string, unknown>,
  restore: RestoreTable,
): { map: Record<string, unknown>; changed: boolean } {
  let changed = false;
  const out: Record<string, unknown> = { ...map };
  for (const key of ["sources", "sourcesContent"] as const) {
    const list = map[key];
    if (!Array.isArray(list)) continue;
    out[key] = list.map((entry: unknown) => {
      if (typeof entry !== "string") return entry;
      const back = restored(restore, entry);
      if (back !== entry) changed = true;
      return back;
    });
  }
  if (Array.isArray(map.sections)) {
    out.sections = map.sections.map((section: unknown) => {
      if (!isRecord(section) || !isRecord(section.map)) return section;
      const nested = restoreMapObject(section.map, restore);
      if (!nested.changed) return section;
      changed = true;
      return { ...section, map: nested.map };
    });
  }
  return { map: out, changed };
}

function restoreSourceMap(json: string, restore: RestoreTable): string {
  if (restore.size === 0) return json;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return json;
  }
  if (!isRecord(parsed)) return json;
  const { map, changed } = restoreMapObject(parsed, restore);
  return changed ? JSON.stringify(map) : json;
}

function restoreProtectionMap<T>(doc: T, restore: RestoreTable, wire: string, local: string): T {
  if (!isRecord(doc) || !Array.isArray(doc.files)) return doc;
  return {
    ...doc,
    files: doc.files.map((entry: unknown) => {
      if (!isRecord(entry) || !isRecord(entry.file) || typeof entry.file.path !== "string") {
        return entry;
      }
      const path = entry.file.path === wire ? local : restored(restore, entry.file.path);
      const original = entry.file.originalSource;
      const originalSource = typeof original === "string" ? restored(restore, original) : original;
      return path === entry.file.path && originalSource === original
        ? entry
        : { ...entry, file: { ...entry.file, path, originalSource } };
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

export function wireEngineConfig(
  config: CoreConfig,
  wirePaths: ReadonlyMap<string, string>,
): CoreConfig {
  const exclude = config.paths?.exclude;
  const reserved = config.identifiers?.reserved;
  if (exclude === undefined && reserved === undefined) return config;
  const pairs = [...wirePaths.entries()];
  const out: CoreConfig = { ...config };
  if (exclude !== undefined) {
    out.paths = {
      ...config.paths,
      exclude: [...new Set(exclude.flatMap((pattern) => wireGlob(pattern, pairs)))],
    };
  }
  if (reserved !== undefined) {
    out.identifiers = {
      ...config.identifiers,
      reserved: reserved.flatMap((entry): (string | GlobReserved)[] =>
        typeof entry === "string"
          ? [entry]
          : wireGlob(entry.glob, pairs).map((glob) => ({ ...entry, glob })),
      ),
    };
  }
  return out;
}

export interface WireBatch {
  inputs: EngineFileInput[];
  config: CoreConfig;
  toLocal(batch: EngineBatchResult): EngineBatchResult;
}

function localDiagnostics(
  diagnostics: unknown,
  localPaths: ReadonlyMap<string, string>,
): EngineFileResult["diagnostics"] {
  if (!Array.isArray(diagnostics)) return diagnostics as EngineFileResult["diagnostics"];
  return diagnostics.map((d) => {
    if (!isRecord(d) || typeof d.file !== "string") return d;
    const local = localPaths.get(d.file);
    return local === undefined ? d : { ...d, file: local };
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
  const restores = new Map<string, RestoreTable>();
  const privateRoots = privateRootsOf(rootDir);
  const wiredInputs = inputs.map((input) => {
    const path = wirePaths.get(input.path) ?? input.path;
    const wired: EngineFileInput = { ...input, path };
    if (input.sourceMap !== undefined) {
      const place = { dir: dirname(resolve(input.path)), root: rootDir, privateRoots };
      const map = wireSourceMapWithRestore(input.sourceMap, place);
      restores.set(path, map.restore);
      if (map.json === undefined) delete wired.sourceMap;
      else wired.sourceMap = map.json;
    }
    return wired;
  });
  return {
    inputs: wiredInputs,
    config: wireEngineConfig(config, wirePaths),
    toLocal: (batch) => ({
      ...batch,
      files: batch.files.map((f) => {
        const local = localPaths.get(f.path);
        if (local === undefined) return f;
        const restore = restores.get(f.path) ?? new Map();
        return {
          ...f,
          path: local,
          ...(f.diagnostics === undefined
            ? {}
            : { diagnostics: localDiagnostics(f.diagnostics, localPaths) }),
          ...(typeof f.sourceMap === "string"
            ? { sourceMap: restoreSourceMap(f.sourceMap, restore) }
            : {}),
          ...(f.protectionMap == null
            ? {}
            : { protectionMap: restoreProtectionMap(f.protectionMap, restore, f.path, local) }),
        };
      }),
    }),
  };
}
