import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
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
} from "@afterpack/integration-utils";

const BACKUP_MANIFEST_FILE = "manifest.json";
const SET_ASIDE_SUFFIX = ".previous";

export type JournalState = "applying" | "complete";

export interface BackupManifestFile {
  path: string;
  originalSha256: string | null;
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

export function backupDir(projectRoot: string): string {
  return join(projectRoot, AFTERPACK_DIR, "backup");
}

export function backupManifestPath(projectRoot: string): string {
  return join(backupDir(projectRoot), BACKUP_MANIFEST_FILE);
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
  return candidates.find((c) => existsSync(backupManifestPath(c))) ?? null;
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
    (entry.obfuscatedSha256 === undefined || isSha(entry.obfuscatedSha256))
  );
}

function isRename(value: unknown): value is BackupRename {
  const rename = value as Partial<BackupRename> | null;
  return typeof rename?.from === "string" && typeof rename.to === "string";
}

export function readBackupManifest(projectRoot: string): BackupManifestResult {
  const path = backupManifestPath(projectRoot);
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

interface PreImage {
  path: string;
  relPath: string;
  bytes: Buffer | null;
  sha256: string | null;
}

function capturePreImage(projectRoot: string, path: string): PreImage | null {
  const relPath = relPathFor(projectRoot, path);
  try {
    const stats = statSync(path);
    if (!stats.isFile()) return null;
    const bytes = readFileSync(path);
    return { path, relPath, bytes, sha256: sha256OfBytes(bytes) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { path, relPath, bytes: null, sha256: null };
  }
}

function outsideRoot(relPath: string): boolean {
  return relPath === "" || relPath.startsWith("../") || relPath === ".." || isAbsolute(relPath);
}

function writeManifest(projectRoot: string, manifest: BackupManifest): string {
  const path = backupManifestPath(projectRoot);
  const staged = `${path}.tmp`;
  writeFileSync(staged, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(staged, path);
  return path;
}

function byPath<T extends { path: string }>(a: T, b: T): number {
  return a.path.localeCompare(b.path);
}

export interface BeginJournalInput {
  projectRoot: string;
  protectedRoot: string;
  cliVersion: string;
  touched: readonly string[];
  renamed: ReadonlyMap<string, string>;
  persist: boolean;
  merge?: boolean;
}

export interface Journal {
  rollback(): void;
  commit(receiptPath: string | null): WriteBackupsResult | null;
}

export function beginJournal(input: BeginJournalInput): Journal {
  const { projectRoot, persist } = input;
  const images = [...new Set(input.touched)]
    .map((path) => capturePreImage(projectRoot, path))
    .filter((image): image is PreImage => image !== null);
  const renames: BackupRename[] = [...input.renamed]
    .map(([from, to]) => ({ from: relPathFor(projectRoot, from), to: relPathFor(projectRoot, to) }))
    .sort((a, b) => a.from.localeCompare(b.from));

  const dir = backupDir(projectRoot);
  const aside = `${dir}${SET_ASIDE_SUFFIX}`;
  const touchedRel = new Set(images.map((image) => image.relPath));
  let kept: BackupManifestFile[] = [];
  let keptRenames: BackupRename[] = [];
  let previous: BackupManifest | null = null;

  const dropCopies = (relPaths: Iterable<string>): void => {
    for (const relPath of relPaths) rmSync(absoluteFilePath(dir, relPath), { force: true });
  };
  const discardPersisted = (): void => {
    if (previous !== null) {
      const previousPaths = new Set(kept.map((f) => f.path));
      dropCopies([...touchedRel].filter((relPath) => !previousPaths.has(relPath)));
      writeManifest(projectRoot, { ...previous, files: kept });
      return;
    }
    rmSync(dir, { recursive: true, force: true });
    if (existsSync(aside)) renameSync(aside, dir);
  };

  if (persist) {
    const escaped = images.find((image) => outsideRoot(image.relPath));
    if (escaped) throw new BackupOutsideProjectError(escaped.path, projectRoot);
    const existing = input.merge ? readBackupManifest(projectRoot) : null;
    if (
      existing?.status === "ok" &&
      existing.manifest.state === "complete" &&
      existing.manifest.protectedRoot === input.protectedRoot
    ) {
      previous = existing.manifest;
      kept = previous.files.filter((f) => !touchedRel.has(f.path));
      keptRenames = previous.renames;
    } else {
      rmSync(aside, { recursive: true, force: true });
      if (existsSync(dir)) renameSync(dir, aside);
    }
    try {
      mkdirSync(dir, { recursive: true });
      ensureAfterpackGitignore(dir);
      for (const image of images) {
        if (image.bytes === null) continue;
        const dest = absoluteFilePath(dir, image.relPath);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, image.bytes);
      }
      writeManifest(projectRoot, {
        schema: 2,
        state: "applying",
        timestamp: new Date().toISOString(),
        protectedRoot: input.protectedRoot,
        cliVersion: input.cliVersion,
        receiptPath: null,
        files: [
          ...kept,
          ...images.map((image) => ({ path: image.relPath, originalSha256: image.sha256 })),
        ].sort(byPath),
        renames: [...keptRenames, ...renames],
      });
    } catch (error) {
      discardPersisted();
      throw error;
    }
  }

  return {
    rollback() {
      for (const image of [...images].reverse()) {
        if (image.bytes === null) {
          rmSync(image.path, { force: true });
        } else if (currentSha256(image.path) !== image.sha256) {
          mkdirSync(dirname(image.path), { recursive: true });
          writeFileSync(image.path, image.bytes);
        }
      }
      if (persist) discardPersisted();
    },
    commit(receiptPath) {
      const changed: BackupManifestFile[] = [];
      const unchanged: string[] = [];
      for (const image of images) {
        const after = currentSha256(image.path);
        if (after === image.sha256) unchanged.push(image.relPath);
        else
          changed.push({
            path: image.relPath,
            originalSha256: image.sha256,
            obfuscatedSha256: after,
          });
      }
      if (!persist) return null;
      dropCopies(unchanged.filter((relPath) => !kept.some((f) => f.path === relPath)));
      const files = [...kept, ...changed].sort(byPath);
      const manifestPath = writeManifest(projectRoot, {
        schema: 2,
        state: "complete",
        timestamp: new Date().toISOString(),
        protectedRoot: input.protectedRoot,
        cliVersion: input.cliVersion,
        receiptPath,
        files,
        renames: [...keptRenames, ...renames],
      });
      rmSync(aside, { recursive: true, force: true });
      return { manifestPath, count: files.length };
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
