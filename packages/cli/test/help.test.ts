import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { engineCalls, processBatch } from "../../../test/core-fake.js";
import { CONTACT_FOOTER } from "../src/args.js";
import { run } from "../src/run.js";

let root: string;
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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "afterpack-help-"));
  out = [];
  err = [];
  engineCalls.length = 0;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("help", () => {
  it("the short --help lists all three commands and the common options, but not the full reference", async () => {
    expect(await invoke(["--help"])).toBe(0);
    const help = out.join("\n");
    expect(help).toContain("afterpack verify [dir]");
    expect(help).toContain("afterpack restore [dir]");
    expect(help).toContain("afterpack audit <url>");
    expect(help).toContain("--diagnostics.format=<text|json>");
    expect(help).toContain("--diagnostics.level=<summary|all|none>");
    expect(help).toContain("--help --all");
    expect(help).not.toContain("Exit codes:");
    expect(help.split("\n").length).toBeLessThanOrEqual(30);
  });

  it("--help --all lists every option, the restore command, and the exit codes, without the RESERVED codes", async () => {
    expect(await invoke(["--help", "--all"])).toBe(0);
    const help = out.join("\n");
    expect(help).toContain("--paths.include=<string[,...]>");
    expect(help).toContain("--identifiers.reserved=<name[,...]>");
    expect(help).toContain("restore [dir]");
    expect(help).toContain("Exit codes:");
    expect(help).toContain("64  misuse");
    expect(help).not.toContain("RESERVED");
  });

  it("answers `verify --help`, `restore --help` and `audit --help` with their own page", async () => {
    expect(await invoke(["verify", "--help"])).toBe(0);
    expect(out.join("\n")).toContain("usage: afterpack verify [dir]");
    expect(out.join("\n")).not.toContain("afterpack audit <url>");

    out = [];
    expect(await invoke(["restore", "--help"])).toBe(0);
    expect(out.join("\n")).toContain("usage: afterpack restore [dir]");
    expect(out.join("\n")).not.toContain("afterpack audit <url>");

    out = [];
    expect(await invoke(["audit", "--help"])).toBe(0);
    expect(out.join("\n")).toContain("usage: afterpack audit <url>");
    expect(out.join("\n")).toContain("AFTERPACK_API_URL");
  });

  it("takes -h and -v as the documented short forms of --help and --version", async () => {
    expect(await invoke(["-h"])).toBe(0);
    expect(out.join("\n")).toContain("usage: afterpack");

    out = [];
    expect(await invoke(["-v"])).toBe(0);
    expect(out.join("\n")).toBe("9.9.9");

    out = [];
    expect(await invoke(["verify", "-h"])).toBe(0);
    expect(out.join("\n")).toContain("usage: afterpack verify");
  });

  it("still refuses every OTHER short flag rather than guessing", async () => {
    expect(await invoke(["dist", "-p"])).toBe(64);
    expect(await invoke(["dist", "-c=2"])).toBe(64);
    expect(engineCalls).toHaveLength(0);
  });

  it("answers --help before an afterpack.json can refuse anything", async () => {
    expect(await invoke(["--help"])).toBe(0);
    expect(err).toEqual([]);
  });

  it("ends the full help page and every subcommand's page with the one contact line", async () => {
    expect(CONTACT_FOOTER).toBe("contact https://www.afterpack.dev/contact");
    for (const argv of [
      ["--help", "--all"],
      ["verify", "--help"],
      ["restore", "--help"],
      ["audit", "--help"],
    ]) {
      out = [];
      expect(await invoke(argv)).toBe(0);
      expect(out.join("\n").trimEnd().endsWith(CONTACT_FOOTER)).toBe(true);
    }
  });

  it("the short --help ends with the --all pointer and the docs line instead", async () => {
    expect(await invoke(["--help"])).toBe(0);
    const lastLines = out.join("\n").trimEnd().split("\n").slice(-2);
    expect(lastLines[0]).toContain("afterpack --help --all");
    expect(lastLines[1]).toContain("docs");
    expect(lastLines[1]).toContain("https://www.afterpack.dev/docs/cli");
  });

  it("closes every error with the same contact line as its last output", async () => {
    for (const argv of [
      ["dist", "--nope=1"],
      ["nope-nope-nope"],
      ["verify", "no-such-dir"],
      ["restore", "no-such-dir"],
      ["audit"],
      ["audit", "a", "b"],
    ]) {
      err = [];
      expect(await invoke(argv)).not.toBe(0);
      expect(err.at(-1), `\`afterpack ${argv.join(" ")}\` last stderr line`).toBe(CONTACT_FOOTER);
    }
  });
});
