import { createHash } from "node:crypto";
import { chmodSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

const STAGED_SUFFIX = ".afterpack-tmp";

export function stagedPath(path: string): string {
  return `${path}${STAGED_SUFFIX}`;
}

export function sha256Hex(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function writeFileAtomic(path: string, content: string | Uint8Array): void {
  const staged = stagedPath(path);
  let mode: number | null = null;
  try {
    mode = statSync(path).mode & 0o7777;
  } catch {
    mode = null;
  }
  try {
    writeFileSync(staged, content);
    if (mode !== null) chmodSync(staged, mode);
    renameSync(staged, path);
  } catch (error) {
    try {
      rmSync(staged, { force: true });
    } catch {}
    throw error;
  }
}
