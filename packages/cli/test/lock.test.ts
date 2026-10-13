import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, LOCK_MAX_AGE_MS, LockHeldError } from "../src/lock.js";

let dir: string;
let lockPath: string;
let notices: string[];

const DEAD_PID = 2 ** 22 + 12345;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "afterpack-lock-")));
  lockPath = join(dir, "slot", "lock");
  notices = [];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function plant(owner: Record<string, unknown>): void {
  acquireLock(lockPath, () => {});
  writeFileSync(lockPath, JSON.stringify(owner));
}

const take = () => acquireLock(lockPath, (m) => notices.push(m));

describe("acquireLock", () => {
  it("records the process, the host and a token, and releases only its own lock", () => {
    const lock = take();
    const owner = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(owner).toMatchObject({ pid: process.pid, host: hostname() });
    expect(typeof owner.token).toBe("string");
    expect(() => take()).toThrow(LockHeldError);
    lock.release();
    expect(() => take().release()).not.toThrow();
  });

  it("treats another host's lock as live even when its pid is free here", () => {
    plant({
      pid: DEAD_PID,
      host: "build-agent-2",
      startedAt: new Date().toISOString(),
      token: "t",
    });
    expect(() => take()).toThrow(LockHeldError);
  });

  it("takes over another host's lock once it is past the age bound", () => {
    const old = new Date(Date.now() - LOCK_MAX_AGE_MS - 60_000).toISOString();
    plant({ pid: 1, host: "build-agent-2", startedAt: old, token: "t" });
    take();
    expect(notices.join("\n")).toContain("more than two hours ago");
  });

  it("takes over this host's lock whose process is gone", () => {
    plant({ pid: DEAD_PID, host: hostname(), startedAt: new Date().toISOString(), token: "t" });
    take();
    expect(notices.join("\n")).toContain("no longer running");
  });

  it("takes over an old unreadable lock through the same create-and-check, so one taker wins", () => {
    plant({});
    writeFileSync(lockPath, "{");
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(lockPath, old, old);
    const first = take();
    expect(notices.join("\n")).toContain("unreadable");
    expect(() => take()).toThrow(LockHeldError);
    first.release();
  });

  it("leaves a fresh unreadable lock alone", () => {
    plant({});
    writeFileSync(lockPath, "");
    expect(() => take()).toThrow(LockHeldError);
  });
});
