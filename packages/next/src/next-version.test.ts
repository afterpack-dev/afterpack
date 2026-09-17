import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withAfterpack } from "./index.js";
import { assertSupportedNext, detectNextVersion, MIN_NEXT_VERSION } from "./next-version.js";

let root: string;

function fakeNextInstall(version: string): string {
  const dir = mkdtempSync(join(root, "project-"));
  const pkgDir = join(dir, "node_modules", "next");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "next", version }));
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "afterpack-next-version-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("assertSupportedNext", () => {
  it("refuses a Next older than the release that ships runAfterProductionCompile", () => {
    for (const version of ["14.0.0", "14.2.30", "15.0.0", "15.3.5"]) {
      expect(() => assertSupportedNext(version)).toThrow(MIN_NEXT_VERSION);
      expect(() => assertSupportedNext(version)).toThrow(/CLEARTEXT/);
    }
  });

  it("accepts the floor itself, anything newer, and its canaries", () => {
    for (const version of ["15.4.0", "15.4.1", "15.5.0", "16.2.6", "15.4.0-canary.12"]) {
      expect(() => assertSupportedNext(version)).not.toThrow();
    }
  });

  it("stays out of the way when no Next version can be read", () => {
    expect(() => assertSupportedNext(null)).not.toThrow();
    expect(() => assertSupportedNext("not-a-version")).not.toThrow();
  });
});

describe("detectNextVersion", () => {
  it("reads the version out of the installed next/package.json", () => {
    expect(detectNextVersion(fakeNextInstall("15.4.2"))).toBe("15.4.2");
  });

  it("returns null when next is not installed at or above the directory", () => {
    expect(detectNextVersion(mkdtempSync(join(root, "bare-")))).toBeNull();
  });
});

describe("withAfterpack version guard", () => {
  it("throws at next.config load time on a Next that would ignore the hook", () => {
    vi.spyOn(process, "cwd").mockReturnValue(fakeNextInstall("14.2.30"));
    expect(() => withAfterpack({})).toThrow(MIN_NEXT_VERSION);
  });

  it("installs the hook on a Next that runs it", () => {
    vi.spyOn(process, "cwd").mockReturnValue(fakeNextInstall(MIN_NEXT_VERSION));
    const wrapped = withAfterpack({}) as {
      compiler?: { runAfterProductionCompile?: unknown };
    };
    expect(typeof wrapped.compiler?.runAfterProductionCompile).toBe("function");
  });
});
