import { describe, expect, it } from "vitest";
import { fmtElapsed, formatPassSummary } from "./summary.js";

const BASE = {
  label: "afterpack-vite",
  fileCount: 3,
  inputBytes: 500,
  outputBytes: 800,
  unobfuscatedCount: 0,
  noOpCount: 0,
};

describe("fmtElapsed", () => {
  it("shows whole milliseconds under one second", () => {
    expect(fmtElapsed(420)).toBe("420ms");
    expect(fmtElapsed(0)).toBe("0ms");
    expect(fmtElapsed(999)).toBe("999ms");
  });

  it("shows seconds to one decimal at or above one second", () => {
    expect(fmtElapsed(1000)).toBe("1.0s");
    expect(fmtElapsed(1420)).toBe("1.4s");
    expect(fmtElapsed(12_340)).toBe("12.3s");
  });
});

describe("formatPassSummary", () => {
  it("cli style: ends the line with elapsed time, after the byte totals", () => {
    const line = formatPassSummary({ ...BASE, elapsedMs: 1420 }, "cli");
    expect(line).toBe("✓ Protected 3 files · 500 B → 800 B · 1.4s");
  });

  it("plugin style: labels the pass and ends with elapsed time", () => {
    const line = formatPassSummary({ ...BASE, elapsedMs: 420 }, "plugin");
    expect(line).toBe("[afterpack-vite] Protected 3 files · 500 B → 800 B · 420ms");
  });

  it("keeps elapsed as the LAST field even with unobfuscated/no-op suffixes", () => {
    const line = formatPassSummary(
      { ...BASE, unobfuscatedCount: 1, noOpCount: 2, elapsedMs: 1420 },
      "cli",
    );
    expect(line.endsWith("· 1.4s")).toBe(true);
    expect(line).toContain("shipped UNOBFUSCATED");
    expect(line).toContain("no-op (unchanged)");
  });
});
