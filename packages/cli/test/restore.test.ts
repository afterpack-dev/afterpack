import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __reset, __setProcessResult, processBatch } from "../../../test/core-fake.js";
import { CONTACT_FOOTER } from "../src/args.js";
import { RESTORE_USAGE } from "../src/restore.js";
import { run } from "../src/run.js";

let root: string;
let buildDir: string;
let out: string[];
let err: string[];

const logger = {
  log: (m: string) => out.push(m),
  error: (m: string) => err.push(m),
  warn: () => {},
};

function invoke(argv: string[]): Promise<number> {
  return run({
    argv,
    cwd: root,
    engine: { processBatch },
    logger,
    version: "9.9.9",
    env: {},
    stdout: { isTTY: false, write: () => {} },
  });
}

const QUIET = ["--protectionMap.enabled=false", "--telemetry.enabled=false"];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "afterpack-restore-test-"));
  buildDir = join(root, "dist");
  mkdirSync(buildDir, { recursive: true });
  out = [];
  err = [];
  __reset();
  __setProcessResult((input) => ({ code: `OBF:${input}`, sourceMap: null, protectionMap: null }));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("afterpack restore", () => {
  it("round-trips a backup-and-restore: undoes the run and reports it", async () => {
    writeFileSync(join(buildDir, "app.js"), "export const a = 1;");

    expect(await invoke(["dist", ...QUIET])).toBe(0);
    expect(readFileSync(join(buildDir, "app.js"), "utf8")).toContain("OBF:");

    expect(await invoke(["restore"])).toBe(0);
    expect(out.join("\n")).toContain("Restored 1 file · dist/");
    expect(readFileSync(join(buildDir, "app.js"), "utf8")).toBe("export const a = 1;");
  });

  it("restores what it can and refuses the file that changed since obfuscation, exit 1", async () => {
    writeFileSync(join(buildDir, "app.js"), "export const a = 1;");
    writeFileSync(join(buildDir, "b.js"), "export const b = 2;");
    expect(await invoke(["dist", ...QUIET])).toBe(0);

    writeFileSync(join(buildDir, "app.js"), "tampered after the build");

    expect(await invoke(["restore"])).toBe(1);
    const text = err.join("\n");
    expect(text).toContain("changed since obfuscation");
    expect(text).toContain("dist/app.js");
    expect(text.trimEnd().endsWith(CONTACT_FOOTER)).toBe(true);

    expect(readFileSync(join(buildDir, "app.js"), "utf8")).toBe("tampered after the build");
    expect(readFileSync(join(buildDir, "b.js"), "utf8")).toBe("export const b = 2;");
  });

  it("refuses with `Nothing to restore` and the contact line when there is no manifest", async () => {
    expect(await invoke(["restore"])).toBe(1);
    const text = err.join("\n");
    expect(text).toContain("✗");
    expect(text).toContain("Nothing to restore");
    expect(text.trimEnd().endsWith(CONTACT_FOOTER)).toBe(true);
  });

  it("refuses with `Nothing to restore` when --build.backup=false skipped the backup", async () => {
    writeFileSync(join(buildDir, "app.js"), "export const a = 1;");
    expect(await invoke(["dist", ...QUIET, "--build.backup=false"])).toBe(0);

    expect(await invoke(["restore"])).toBe(1);
    expect(err.join("\n")).toContain("Nothing to restore");
  });

  it("answers `restore --help` with its own page", async () => {
    expect(await invoke(["restore", "--help"])).toBe(0);
    expect(out.join("\n")).toContain(RESTORE_USAGE);
  });

  it("rejects a second positional", async () => {
    expect(await invoke(["restore", ".", "also-this"])).toBe(64);
    expect(err.join("\n")).toContain("expected a single [dir]");
  });

  it("reports a path that does not exist rather than a missing manifest", async () => {
    expect(await invoke(["restore", "nope"])).toBe(1);
    expect(err.join("\n")).toContain("path not found: nope");
  });
});
