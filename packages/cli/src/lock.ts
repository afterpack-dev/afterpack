import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

export const LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const UNREADABLE_GRACE_MS = 60 * 1000;

interface LockOwner {
  pid: number;
  startedAt: string;
  token: string;
}

export class LockHeldError extends Error {
  readonly code = "BUILD_DIR_LOCKED";
  readonly lockPath: string;

  constructor(lockPath: string, owner: LockOwner | null) {
    super(
      owner
        ? `Another afterpack run (process ${owner.pid}, started ${owner.startedAt}) is working on ` +
            "this build directory"
        : "Another afterpack run is working on this build directory",
    );
    this.name = "LockHeldError";
    this.lockPath = lockPath;
  }
}

export interface HeldLock {
  release(): void;
}

function readOwner(path: string): LockOwner | null {
  try {
    const owner = JSON.parse(readFileSync(path, "utf8")) as Partial<LockOwner>;
    if (typeof owner.pid !== "number" || typeof owner.startedAt !== "string") return null;
    if (typeof owner.token !== "string") return null;
    return owner as LockOwner;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function staleReason(path: string, owner: LockOwner | null, now: number): string | null {
  if (owner === null) {
    let age = 0;
    try {
      age = now - statSync(path).mtimeMs;
    } catch {
      return null;
    }
    return age > UNREADABLE_GRACE_MS ? "an unreadable lock" : null;
  }
  if (!alive(owner.pid)) return `a lock left by process ${owner.pid}, which is no longer running`;
  const started = Date.parse(owner.startedAt);
  if (Number.isFinite(started) && now - started > LOCK_MAX_AGE_MS) {
    return `a lock taken by process ${owner.pid} more than two hours ago`;
  }
  return null;
}

function tryCreate(path: string, owner: LockOwner): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(fd, JSON.stringify(owner));
  } finally {
    closeSync(fd);
  }
  return true;
}

export function acquireLock(path: string, notice: (message: string) => void): HeldLock {
  mkdirSync(dirname(path), { recursive: true });
  const owner: LockOwner = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token: randomUUID(),
  };
  if (!tryCreate(path, owner)) {
    const current = readOwner(path);
    const reason = staleReason(path, current, Date.now());
    if (reason === null) throw new LockHeldError(path, current);
    const evicted = `${path}.stale-${owner.token}`;
    try {
      renameSync(path, evicted);
    } catch {
      throw new LockHeldError(path, readOwner(path));
    }
    const moved = readOwner(evicted);
    if (current !== null && moved?.token !== current.token) {
      if (!existsSync(path)) renameSync(evicted, path);
      throw new LockHeldError(path, moved);
    }
    rmSync(evicted, { force: true });
    if (!tryCreate(path, owner)) throw new LockHeldError(path, readOwner(path));
    notice(`Took over ${reason}.`);
  }
  return {
    release() {
      if (readOwner(path)?.token !== owner.token) return;
      rmSync(path, { force: true });
      try {
        rmdirSync(dirname(path));
      } catch {}
    },
  };
}
