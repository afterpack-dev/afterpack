import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import {
  AFTERPACK_DIR,
  afterpackHome,
  ensureAfterpackGitignore,
  sha256Of,
} from "@afterpack/integration-utils";

const BACKUP_MANIFEST_FILE = "manifest.json";

export interface BackupManifestFile {
  path: string;
  originalSha256: string;
  obfuscatedSha256: string;
}

export interface BackupManifest {
  schema: 1;
  timestamp: string;
  protectedRoot: string;
  cliVersion: string;
  receiptPath: string | null;
  files: BackupManifestFile[];
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

export function readBackupManifest(projectRoot: string): BackupManifestResult {
  const path = backupManifestPath(projectRoot);
  if (!existsSync(path)) return { status: "missing" };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BackupManifest>;
    if (parsed.schema !== 1 || !Array.isArray(parsed.files)) return { status: "corrupt", path };
    if (typeof parsed.protectedRoot !== "string") return { status: "corrupt", path };
    return { status: "ok", manifest: parsed as BackupManifest };
  } catch {
    return { status: "corrupt", path };
  }
}

interface WriteBackupsInput {
  projectRoot: string;
  protectedRoot: string;
  cliVersion: string;
  pending: readonly PendingBackup[];
  receiptPath: string | null;
  merge?: boolean;
}

export interface WriteBackupsResult {
  manifestPath: string;
  count: number;
}

export function writeBackups(input: WriteBackupsInput): WriteBackupsResult {
  const dir = backupDir(input.projectRoot);
  const previous = input.merge ? readBackupManifest(input.projectRoot) : null;
  const replaced = new Set(input.pending.map((p) => p.relPath));
  const files: BackupManifestFile[] =
    previous?.status === "ok" && previous.manifest.protectedRoot === input.protectedRoot
      ? previous.manifest.files.filter((f) => !replaced.has(f.path))
      : [];
  if (files.length === 0) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  ensureAfterpackGitignore(dir);
  for (const pending of input.pending) {
    const dest = absoluteFilePath(dir, pending.relPath);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, pending.originalBytes);
    files.push({
      path: pending.relPath,
      originalSha256: pending.originalSha256,
      obfuscatedSha256: sha256Of(pending.filePath),
    });
  }
  const manifest: BackupManifest = {
    schema: 1,
    timestamp: new Date().toISOString(),
    protectedRoot: input.protectedRoot,
    cliVersion: input.cliVersion,
    receiptPath: input.receiptPath,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
  };
  const manifestPath = backupManifestPath(input.projectRoot);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifestPath, count: files.length };
}

export function matchAlreadyObfuscated(
  manifest: BackupManifest,
  pending: readonly PendingBackup[],
): string[] {
  const byPath = new Map(manifest.files.map((f) => [f.path, f] as const));
  return pending
    .filter((p) => {
      const entry = byPath.get(p.relPath);
      return entry !== undefined && p.originalSha256 === entry.obfuscatedSha256;
    })
    .map((p) => p.filePath);
}
