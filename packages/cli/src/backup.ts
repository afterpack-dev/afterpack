import { createHash } from "node:crypto";
import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  AFTERPACK_DIR,
  afterpackHome,
  ensureAfterpackGitignore,
  stagedPath,
} from "@afterpack/integration-utils";

const BACKUP_MANIFEST_FILE = "manifest.json";
const LEGACY_BACKUP_DIR = "backup";
const BACKUPS_DIR = "backups";

export type JournalState = "applying" | "complete";

export interface BackupManifestFile {
  path: string;
  originalSha256: string | null;
  plannedSha256?: (string | null)[];
  obfuscatedSha256?: string | null;
}

export interface BackupRename {
  from: string;
  to: string;
}

export interface BackupManifest {
  schema: 2;
  state: JournalState;
  timestamp: string;
  protectedRoot: string;
  cliVersion: string;
  receiptPath: string | null;
  files: BackupManifestFile[];
  renames: BackupRename[];
}

export interface BackupSlot {
  projectRoot: string;
  container: string;
  current: string;
  previous: string;
  manifestPath: string;
  lockPath: string;
  legacy: boolean;
}

export function backupsDir(projectRoot: string): string {
  return join(projectRoot, AFTERPACK_DIR, BACKUPS_DIR);
}

export function backupSlot(projectRoot: string, key: string): BackupSlot {
  const container = join(backupsDir(projectRoot), key.replace(/^\./, "%2E"));
  const current = join(container, "current");
  return {
    projectRoot,
    container,
    current,
    previous: join(container, "previous"),
    manifestPath: join(current, BACKUP_MANIFEST_FILE),
    lockPath: join(container, "lock"),
    legacy: false,
  };
}

export function legacySlot(projectRoot: string): BackupSlot {
  const current = join(projectRoot, AFTERPACK_DIR, LEGACY_BACKUP_DIR);
  return {
    projectRoot,
    container: current,
    current,
    previous: `${current}.previous`,
    manifestPath: join(current, BACKUP_MANIFEST_FILE),
    lockPath: `${current}.lock`,
    legacy: true,
  };
}

export function copyPath(slot: BackupSlot, relPath: string): string {
  return slot.legacy
    ? absoluteFilePath(slot.current, relPath)
    : absoluteFilePath(join(slot.current, "files"), relPath);
}

export function hasBackup(slot: BackupSlot): boolean {
  return existsSync(slot.manifestPath) || existsSync(join(slot.previous, BACKUP_MANIFEST_FILE));
}

export function slotsUnder(projectRoot: string): BackupSlot[] {
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(backupsDir(projectRoot), { withFileTypes: true });
  } catch {
    entries = [];
  }
  const slots = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => backupSlot(projectRoot, decodeSlotName(entry.name)))
    .filter(hasBackup)
    .sort((a, b) => a.container.localeCompare(b.container));
  const legacy = legacySlot(projectRoot);
  return existsSync(legacy.manifestPath) ? [legacy, ...slots] : slots;
}

function decodeSlotName(name: string): string {
  return name.startsWith("%2E") ? `.${name.slice(3)}` : name;
}

function homeProjectRoot(dir: string): string | null {
  try {
    return afterpackHome(dir).projectRoot;
  } catch {
    return null;
  }
}

export function findBackupProjectRoot(dir: string): string | null {
  const candidates = [dir, homeProjectRoot(dir)].filter((c): c is string => c !== null);
  return candidates.find((c) => slotsUnder(c).length > 0) ?? null;
}

export function recoverSlot(slot: BackupSlot): void {
  if (slot.legacy) return;
  if (existsSync(slot.manifestPath)) {
    rmSync(slot.previous, { recursive: true, force: true });
    return;
  }
  if (!existsSync(join(slot.previous, BACKUP_MANIFEST_FILE))) return;
  rmSync(slot.current, { recursive: true, force: true });
  renameSync(slot.previous, slot.current);
}

export function discardSlot(slot: BackupSlot): void {
  if (slot.legacy) {
    rmSync(slot.current, { recursive: true, force: true });
    return;
  }
  rmSync(slot.current, { recursive: true, force: true });
  rmSync(slot.previous, { recursive: true, force: true });
}

function toPosixPath(value: string): string {
  return value.split(sep).join("/");
}

function relPathFor(projectRoot: string, filePath: string): string {
  return toPosixPath(relative(projectRoot, filePath));
}

export function absoluteFilePath(projectRoot: string, relPath: string): string {
  return join(projectRoot, ...relPath.split("/"));
}

function sha256OfBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function currentSha256(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return null;
    return sha256OfBytes(readFileSync(path));
  } catch {
    return null;
  }
}

export interface PendingBackup {
  filePath: string;
  relPath: string;
  originalBytes: Buffer;
  originalSha256: string;
}

export function captureOriginals(projectRoot: string, files: readonly string[]): PendingBackup[] {
  return files.map((filePath) => {
    const originalBytes = readFileSync(filePath);
    return {
      filePath,
      relPath: relPathFor(projectRoot, filePath),
      originalBytes,
      originalSha256: sha256OfBytes(originalBytes),
    };
  });
}

export type BackupManifestResult =
  | { status: "missing" }
  | { status: "corrupt"; path: string }
  | { status: "ok"; manifest: BackupManifest };

function isSha(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && /^[0-9a-f]{64}$/.test(value));
}

function isEntry(value: unknown, legacy: boolean): value is BackupManifestFile {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<BackupManifestFile>;
  if (typeof entry.path !== "string" || entry.path === "") return false;
  if (legacy) {
    return typeof entry.originalSha256 === "string" && typeof entry.obfuscatedSha256 === "string";
  }
  return (
    isSha(entry.originalSha256) &&
    (entry.obfuscatedSha256 === undefined || isSha(entry.obfuscatedSha256)) &&
    (entry.plannedSha256 === undefined ||
      (Array.isArray(entry.plannedSha256) && entry.plannedSha256.every(isSha)))
  );
}

function isRename(value: unknown): value is BackupRename {
  const rename = value as Partial<BackupRename> | null;
  return typeof rename?.from === "string" && typeof rename.to === "string";
}

export function readBackupManifest(slot: BackupSlot): BackupManifestResult {
  const path = slot.manifestPath;
  if (!existsSync(path)) return { status: "missing" };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Omit<
      Partial<BackupManifest>,
      "schema"
    > & { schema?: unknown };
    if (typeof parsed.protectedRoot !== "string" || !Array.isArray(parsed.files)) {
      return { status: "corrupt", path };
    }
    if (parsed.schema === 1) {
      if (!parsed.files.every((f) => isEntry(f, true))) return { status: "corrupt", path };
      return {
        status: "ok",
        manifest: { ...(parsed as BackupManifest), schema: 2, state: "complete", renames: [] },
      };
    }
    if (parsed.schema !== 2) return { status: "corrupt", path };
    if (parsed.state !== "applying" && parsed.state !== "complete") {
      return { status: "corrupt", path };
    }
    if (!parsed.files.every((f) => isEntry(f, false))) return { status: "corrupt", path };
    if (!Array.isArray(parsed.renames) || !parsed.renames.every(isRename)) {
      return { status: "corrupt", path };
    }
    return { status: "ok", manifest: parsed as BackupManifest };
  } catch {
    return { status: "corrupt", path };
  }
}

export type EntryStatus = "original" | "expected" | "unexpected";

function scratch(entry: BackupManifestFile): boolean {
  return (
    entry.originalSha256 === null &&
    entry.plannedSha256 !== undefined &&
    entry.plannedSha256.every((state) => state === null)
  );
}

export function entryStatus(
  projectRoot: string,
  manifest: BackupManifest,
  entry: BackupManifestFile,
): EntryStatus {
  const current = currentSha256(absoluteFilePath(projectRoot, entry.path));
  if (current === entry.originalSha256) return "original";
  if (scratch(entry)) return "expected";
  if (entry.obfuscatedSha256 !== undefined && current === entry.obfuscatedSha256) return "expected";
  if (manifest.state === "applying" && entry.plannedSha256?.includes(current)) return "expected";
  return "unexpected";
}

export type JournalCondition = "pristine" | "restorable" | "stale" | "mixed";

export function journalCondition(projectRoot: string, manifest: BackupManifest): JournalCondition {
  let pending = 0;
  let changed = 0;
  for (const entry of manifest.files) {
    if (scratch(entry)) continue;
    const status = entryStatus(projectRoot, manifest, entry);
    if (status === "unexpected") changed += 1;
    else if (status === "expected" && entry.plannedSha256 !== undefined) pending += 1;
  }
  if (changed > 0) return pending > 0 ? "mixed" : "stale";
  return pending > 0 ? "restorable" : "pristine";
}

export function changedEntries(projectRoot: string, manifest: BackupManifest): string[] {
  return manifest.files
    .filter((entry) => entryStatus(projectRoot, manifest, entry) === "unexpected")
    .map((entry) => entry.path);
}

export function mixedJournalFix(copies: string): string {
  return (
    "Some files still hold that run's output and others were rebuilt since, so neither " +
    "restoring nor discarding its backup is safe. Rebuild the whole output from source, then run " +
    "afterpack again: it discards the backup once nothing of that run is left. To keep the " +
    `rebuilt files instead, copy the originals of the other files back from ${copies}.`
  );
}

export function discardInterrupted(slot: BackupSlot, manifest: BackupManifest): void {
  removeScratch(slot.projectRoot, manifest);
  const kept = manifest.files.filter(
    (entry) =>
      entry.plannedSha256 === undefined &&
      entryStatus(slot.projectRoot, manifest, entry) === "expected",
  );
  if (kept.length === 0) {
    discardSlot(slot);
    return;
  }
  const keptPaths = new Set(kept.map((entry) => entry.path));
  for (const entry of manifest.files) {
    if (!keptPaths.has(entry.path)) rmSync(copyPath(slot, entry.path), { force: true });
  }
  writeManifestAt(slot.manifestPath, {
    ...manifest,
    state: "complete",
    files: kept,
    renames: manifest.renames.filter((r) => keptPaths.has(r.from) || keptPaths.has(r.to)),
  });
}

export function removeScratch(projectRoot: string, manifest: BackupManifest): void {
  for (const entry of manifest.files) {
    if (scratch(entry)) rmSync(absoluteFilePath(projectRoot, entry.path), { force: true });
  }
}

export function copiesDir(slot: BackupSlot): string {
  return slot.legacy ? slot.current : join(slot.current, "files");
}

export function addScratch(slot: BackupSlot, manifest: BackupManifest, paths: string[]): void {
  const known = new Set(manifest.files.map((entry) => entry.path));
  const scratchEntries = paths
    .map((path) => relPathFor(slot.projectRoot, path))
    .filter((relPath) => !known.has(relPath))
    .map((relPath) => ({ path: relPath, originalSha256: null, plannedSha256: [null] }));
  if (scratchEntries.length === 0) return;
  writeManifestAt(slot.manifestPath, {
    ...manifest,
    files: [...manifest.files, ...scratchEntries].sort(byPath),
  });
}

export interface WriteBackupsResult {
  manifestPath: string;
  count: number;
}

export class BackupOutsideProjectError extends Error {
  readonly code = "BACKUP_OUTSIDE_PROJECT";

  constructor(path: string, projectRoot: string) {
    super(
      `${path} sits outside ${projectRoot}, where AfterPack keeps its backup, so this run could ` +
        "not be undone",
    );
    this.name = "BackupOutsideProjectError";
  }
}

interface Tracked {
  path: string;
  relPath: string;
  bytes: Buffer | null;
  sha256: string | null;
  planned: (string | null)[];
}

function outsideRoot(relPath: string): boolean {
  return relPath === "" || relPath.startsWith("../") || relPath === ".." || isAbsolute(relPath);
}

function writeManifestAt(path: string, manifest: BackupManifest): void {
  const staged = `${path}.tmp`;
  writeFileSync(staged, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(staged, path);
}

function byPath<T extends { path: string }>(a: T, b: T): number {
  return a.path.localeCompare(b.path);
}

export interface BeginJournalInput {
  slot: BackupSlot;
  protectedRoot: string;
  cliVersion: string;
  planned: ReadonlyMap<string, readonly (string | null)[]>;
  renamed: ReadonlyMap<string, string>;
  persist: boolean;
  merge?: boolean;
}

export interface Journal {
  expect(planned: ReadonlyMap<string, string>): void;
  rollback(): void;
  commit(receiptPath: string | null): WriteBackupsResult | null;
}

export function beginJournal(input: BeginJournalInput): Journal {
  const { slot, persist } = input;
  const { projectRoot } = slot;
  const tracked = new Map<string, Tracked>();
  const renames: BackupRename[] = [...input.renamed]
    .map(([from, to]) => ({ from: relPathFor(projectRoot, from), to: relPathFor(projectRoot, to) }))
    .sort((a, b) => a.from.localeCompare(b.from));
  let kept: BackupManifestFile[] = [];
  let keptRenames: BackupRename[] = [];
  let previous: BackupManifest | null = null;

  const track = (path: string): Tracked | null => {
    const known = tracked.get(path);
    if (known) return known;
    const relPath = relPathFor(projectRoot, path);
    let entry: Tracked;
    try {
      if (!statSync(path).isFile()) return null;
      const bytes = readFileSync(path);
      entry = { path, relPath, bytes, sha256: sha256OfBytes(bytes), planned: [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      entry = { path, relPath, bytes: null, sha256: null, planned: [] };
    }
    if (persist && outsideRoot(relPath)) throw new BackupOutsideProjectError(path, projectRoot);
    tracked.set(path, entry);
    return entry;
  };
  const plan = (path: string, state: string | null): Tracked | null => {
    const entry = track(path);
    if (entry && !entry.planned.includes(state)) entry.planned.push(state);
    return entry;
  };

  const applyingManifest = (): BackupManifest => ({
    schema: 2,
    state: "applying",
    timestamp: new Date().toISOString(),
    protectedRoot: input.protectedRoot,
    cliVersion: input.cliVersion,
    receiptPath: null,
    files: [
      ...kept,
      ...[...tracked.values()].map((entry) => ({
        path: entry.relPath,
        originalSha256: entry.sha256,
        plannedSha256: entry.planned,
      })),
    ].sort(byPath),
    renames: [...keptRenames, ...renames],
  });
  const saveCopies = (entries: Iterable<Tracked>): void => {
    for (const entry of entries) {
      if (entry.bytes === null) continue;
      const dest = copyPath(slot, entry.relPath);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, entry.bytes);
    }
  };
  const discardPersisted = (): void => {
    if (previous !== null) {
      const keptPaths = new Set(kept.map((f) => f.path));
      for (const entry of tracked.values()) {
        if (!keptPaths.has(entry.relPath)) rmSync(copyPath(slot, entry.relPath), { force: true });
      }
      writeManifestAt(slot.manifestPath, { ...previous, files: kept });
      return;
    }
    rmSync(slot.current, { recursive: true, force: true });
    if (existsSync(slot.previous)) renameSync(slot.previous, slot.current);
  };

  for (const [path, states] of input.planned) for (const state of states) plan(path, state);

  if (persist) {
    const existing = input.merge ? readBackupManifest(slot) : null;
    if (
      existing?.status === "ok" &&
      existing.manifest.state === "complete" &&
      existing.manifest.protectedRoot === input.protectedRoot
    ) {
      previous = existing.manifest;
      const touched = new Set([...tracked.values()].map((entry) => entry.relPath));
      kept = previous.files.filter((f) => !touched.has(f.path));
      keptRenames = previous.renames;
    } else {
      rmSync(slot.previous, { recursive: true, force: true });
      if (existsSync(slot.current)) renameSync(slot.current, slot.previous);
    }
    try {
      mkdirSync(slot.current, { recursive: true });
      ensureAfterpackGitignore(join(projectRoot, AFTERPACK_DIR));
      saveCopies(tracked.values());
      writeManifestAt(slot.manifestPath, applyingManifest());
    } catch (error) {
      discardPersisted();
      throw error;
    }
  }

  return {
    expect(planned) {
      const added: Tracked[] = [];
      for (const [path, sha256] of planned) {
        const known = tracked.has(path);
        const entry = plan(path, sha256);
        plan(stagedPath(path), null);
        if (entry && !known) added.push(entry);
      }
      if (!persist) return;
      saveCopies(added);
      writeManifestAt(slot.manifestPath, applyingManifest());
    },
    rollback() {
      for (const entry of [...tracked.values()].reverse()) {
        if (entry.bytes === null) {
          rmSync(entry.path, { force: true });
        } else if (currentSha256(entry.path) !== entry.sha256) {
          mkdirSync(dirname(entry.path), { recursive: true });
          writeFileSync(entry.path, entry.bytes);
        }
      }
      if (persist) discardPersisted();
    },
    commit(receiptPath) {
      const changed: BackupManifestFile[] = [];
      const unchanged: string[] = [];
      for (const entry of tracked.values()) {
        const after = currentSha256(entry.path);
        if (after === entry.sha256) unchanged.push(entry.relPath);
        else
          changed.push({
            path: entry.relPath,
            originalSha256: entry.sha256,
            obfuscatedSha256: after,
          });
      }
      if (!persist) return null;
      const keptPaths = new Set(kept.map((f) => f.path));
      for (const relPath of unchanged) {
        if (!keptPaths.has(relPath)) rmSync(copyPath(slot, relPath), { force: true });
      }
      const files = [...kept, ...changed].sort(byPath);
      writeManifestAt(slot.manifestPath, {
        schema: 2,
        state: "complete",
        timestamp: new Date().toISOString(),
        protectedRoot: input.protectedRoot,
        cliVersion: input.cliVersion,
        receiptPath,
        files,
        renames: [...keptRenames, ...renames],
      });
      rmSync(slot.previous, { recursive: true, force: true });
      return { manifestPath: slot.manifestPath, count: files.length };
    },
  };
}

export function matchAlreadyObfuscated(
  manifest: BackupManifest,
  pending: readonly PendingBackup[],
): string[] {
  const byRelPath = new Map(manifest.files.map((f) => [f.path, f] as const));
  return pending
    .filter((p) => {
      const entry = byRelPath.get(p.relPath);
      return (
        typeof entry?.obfuscatedSha256 === "string" && p.originalSha256 === entry.obfuscatedSha256
      );
    })
    .map((p) => p.filePath);
}
