import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_OUTPUT_MODE, resolveOutputMode } from "../src/output.js";

let root: string;

function configFile(config: unknown): void {
  writeFileSync(join(root, "afterpack.json"), JSON.stringify(config));
}

function resolve(argv: string[], env: Record<string, string | undefined> = {}) {
  return resolveOutputMode({ argv, env, cwd: root });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "afterpack-output-mode-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveOutputMode precedence", () => {
  it("falls back to the documented defaults", () => {
    expect(resolve([])).toEqual({ mode: DEFAULT_OUTPUT_MODE, issues: [] });
  });

  it("reads afterpack.json", () => {
    configFile({ diagnostics: { format: "json", level: "all" } });
    expect(resolve([]).mode).toEqual({ format: "json", level: "all" });
  });

  it("lets the environment override afterpack.json", () => {
    configFile({ diagnostics: { format: "json", level: "all" } });
    expect(
      resolve([], { AFTERPACK_diagnostics_format: "text", AFTERPACK_diagnostics_level: "none" })
        .mode,
    ).toEqual({ format: "text", level: "none" });
  });

  it("lets a flag override both the environment and afterpack.json", () => {
    configFile({ diagnostics: { format: "text", level: "all" } });
    expect(
      resolve(["--diagnostics.format=json", "--diagnostics.level=summary"], {
        AFTERPACK_diagnostics_format: "text",
        AFTERPACK_diagnostics_level: "none",
      }).mode,
    ).toEqual({ format: "json", level: "summary" });
  });

  it("keeps each key on its own layer", () => {
    configFile({ diagnostics: { format: "json" } });
    expect(resolve([], { AFTERPACK_diagnostics_level: "none" }).mode).toEqual({
      format: "json",
      level: "none",
    });
  });

  it("reports a malformed value on any layer and keeps the default", () => {
    configFile({ diagnostics: { level: "loud" } });
    const fromFile = resolve([]);
    expect(fromFile.mode.level).toBe(DEFAULT_OUTPUT_MODE.level);
    expect(fromFile.issues.join("\n")).toContain("diagnostics.level");

    rmSync(join(root, "afterpack.json"));
    expect(resolve([], { AFTERPACK_diagnostics_format: "yaml" }).issues.join("\n")).toContain(
      "diagnostics.format",
    );
    expect(resolve(["--diagnostics.format=yaml"]).issues.join("\n")).toContain(
      "diagnostics.format",
    );
  });

  it("stays silent about keys other than the two it resolves", () => {
    configFile({ preset: "nonsense" });
    expect(resolve(["--seed=nope", "--not-a-key=1"], { AFTERPACK_preset: "nonsense" })).toEqual({
      mode: DEFAULT_OUTPUT_MODE,
      issues: [],
    });
  });
});
