import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { engineCalls, processBatch } from "../../../test/core-fake.js";
import { FEEDBACK_FOOTER } from "../src/args.js";
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
  it("lists both commands, the two new output keys and the exit codes", async () => {
    expect(await invoke(["--help"])).toBe(0);
    const help = out.join("\n");
    expect(help).toContain("afterpack verify [dir]");
    expect(help).toContain("afterpack audit <url>");
    expect(help).toContain("--diagnostics.format=<text|json>");
    expect(help).toContain("--diagnostics.level=<summary|all|none>");
    expect(help).toContain("Exit codes:");
    expect(help).toContain("64  misuse");
  });

  it("answers `verify --help` and `audit --help` with their own page", async () => {
    expect(await invoke(["verify", "--help"])).toBe(0);
    expect(out.join("\n")).toContain("usage: afterpack verify [dir]");
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

  it("ends every help page with the one feedback line", async () => {
    expect(FEEDBACK_FOOTER).toBe(
      "Questions and proposals: https://github.com/afterpack-dev/afterpack/discussions · " +
        "Bugs: https://github.com/afterpack-dev/afterpack/issues",
    );
    for (const argv of [["--help"], ["verify", "--help"], ["audit", "--help"]]) {
      out = [];
      expect(await invoke(argv)).toBe(0);
      expect(out.join("\n").trimEnd().endsWith(FEEDBACK_FOOTER)).toBe(true);
    }
  });

  it("closes every error with the same feedback line as its last output", async () => {
    for (const argv of [
      ["dist", "--nope=1"],
      ["nope-nope-nope"],
      ["verify", "no-such-dir"],
      ["audit"],
      ["audit", "a", "b"],
    ]) {
      err = [];
      expect(await invoke(argv)).not.toBe(0);
      expect(err.at(-1), `\`afterpack ${argv.join(" ")}\` last stderr line`).toBe(FEEDBACK_FOOTER);
    }
  });
});
