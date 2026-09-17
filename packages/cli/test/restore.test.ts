import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTECTION_RECEIPT_FILE } from "@afterpack/integration-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __reset, __setProcessResult, processBatch } from "../../../test/core-fake.js";
import { CONTACT_FOOTER } from "../src/args.js";
import { backupManifestPath } from "../src/backup.js";
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

  it("finds the manifest by searching UPWARD: `restore dist` from the project root works", async () => {
    writeFileSync(join(buildDir, "app.js"), "export const a = 1;");
    expect(await invoke(["dist", ...QUIET])).toBe(0);

    expect(await invoke(["restore", "dist"])).toBe(0);
    expect(readFileSync(join(buildDir, "app.js"), "utf8")).toBe("export const a = 1;");
  });

  it("finds the manifest whether restore is pointed at the built directory or run from its parent", async () => {
    const projectDir = join(root, "test-next");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "app.js"), "export const a = 1;");

    expect(await invoke(["test-next", ...QUIET])).toBe(0);
    expect(readFileSync(join(projectDir, "app.js"), "utf8")).toContain("OBF:");

    expect(await invoke(["restore", "test-next"])).toBe(0);
    expect(readFileSync(join(projectDir, "app.js"), "utf8")).toBe("export const a = 1;");
  });

  it("is ATOMIC: one changed file means NOTHING is restored, and it names the file", async () => {
    writeFileSync(join(buildDir, "app.js"), "export const a = 1;");
    writeFileSync(join(buildDir, "b.js"), "export const b = 2;");
    expect(await invoke(["dist", ...QUIET])).toBe(0);
    const obfuscatedB = readFileSync(join(buildDir, "b.js"), "utf8");

    writeFileSync(join(buildDir, "app.js"), "tampered after the build");

    expect(await invoke(["restore"])).toBe(1);
    const text = err.join("\n");
    expect(text).toContain("changed since obfuscation");
    expect(text).toContain("dist/app.js");
    expect(text.trimEnd().endsWith(CONTACT_FOOTER)).toBe(true);

    expect(readFileSync(join(buildDir, "app.js"), "utf8")).toBe("tampered after the build");
    expect(readFileSync(join(buildDir, "b.js"), "utf8")).toBe(obfuscatedB);
    expect(existsSync(backupManifestPath(root))).toBe(true);
  });

  it("deletes the receipt and the whole backup dir on success, but leaves .afterpack/ in place", async () => {
    writeFileSync(join(buildDir, "app.js"), "export const a = 1;");
    expect(await invoke(["dist", ...QUIET])).toBe(0);
    expect(existsSync(join(buildDir, PROTECTION_RECEIPT_FILE))).toBe(true);
    expect(existsSync(join(root, ".afterpack", "backup"))).toBe(true);

    expect(await invoke(["restore"])).toBe(0);
    expect(existsSync(join(buildDir, PROTECTION_RECEIPT_FILE))).toBe(false);
    expect(existsSync(join(root, ".afterpack", "backup"))).toBe(false);
    expect(existsSync(join(root, ".afterpack"))).toBe(true);
  });

  it("never deletes a recorded receipt that sits outside the project root", async () => {
    writeFileSync(join(buildDir, "app.js"), "export const a = 1;");
    expect(await invoke(["dist", ...QUIET])).toBe(0);

    const outside = mkdtempSync(join(tmpdir(), "afterpack-restore-outsider-"));
    const decoy = join(outside, PROTECTION_RECEIPT_FILE);
    writeFileSync(decoy, '{"someone":"else"}');
    const manifestPath = backupManifestPath(root);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.receiptPath = decoy;
    writeFileSync(manifestPath, JSON.stringify(manifest));

    expect(await invoke(["restore"])).toBe(0);
    expect(existsSync(decoy)).toBe(true);
    expect(readFileSync(decoy, "utf8")).toBe('{"someone":"else"}');
    rmSync(outside, { recursive: true, force: true });
  });

  it("leaves `verify` reporting a missing receipt, not a stale mismatch, after a restore", async () => {
    writeFileSync(join(buildDir, "app.js"), "export const a = 1;");
    expect(await invoke(["dist", ...QUIET])).toBe(0);
    expect(await invoke(["restore"])).toBe(0);

    err = [];
    expect(await invoke(["verify", "dist"])).toBe(1);
    expect(err.join("\n")).toContain("no protection receipt found");
  });

  it("round-trips a single FILE target: protect then restore", async () => {
    const file = join(root, "app.js");
    writeFileSync(file, "var a = 1;");

    expect(await invoke(["app.js", ...QUIET])).toBe(0);
    expect(readFileSync(file, "utf8")).toContain("OBF:");

    expect(await invoke(["restore"])).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("var a = 1;");
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

  it("hard-refuses a corrupt manifest, naming the path and exiting 1", async () => {
    mkdirSync(join(root, ".afterpack", "backup"), { recursive: true });
    writeFileSync(backupManifestPath(root), "not json");

    expect(await invoke(["restore"])).toBe(1);
    const text = err.join("\n");
    expect(text).toContain("Backup manifest is unreadable");
    expect(text).toContain(".afterpack/backup/manifest.json");
    expect(text).not.toContain(root);
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
