import { existsSync, readFileSync } from "node:fs";
import { expect } from "@playwright/test";
import type { ObfuscationExpectation } from "./expectations.js";
import type { Fixture } from "./registry.js";

const SUMMARY_LINE =
  /(?:\[([^\]]+)\]|(✓)) Protected (\d+) files? · ([\d.]+ [A-Za-z]+) → ([\d.]+ [A-Za-z]+)([^\n]*)/g;

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ESC byte is the point.
const ANSI = /\x1b\[[0-9;]*m/g;

const BYTE_SIZE = /^([\d.]+) (B|KB|MB)$/;

function parseBytes(text: string): number {
  const match = BYTE_SIZE.exec(text);
  if (!match) return Number.NaN;
  const value = Number(match[1]);
  if (match[2] === "KB") return value * 1024;
  if (match[2] === "MB") return value * 1024 * 1024;
  return value;
}

export interface ObfuscationPass {
  passLabel: string;
  files: number;
  ratioPercent: number;
  unobfuscated: boolean;
  noOp: number;
  seed: string | null;
  seedOrigin: string | null;
}

export function parseObfuscationPasses(log: string): ObfuscationPass[] {
  const out: ObfuscationPass[] = [];
  const plain = log.replace(ANSI, "");
  for (const match of plain.matchAll(SUMMARY_LINE)) {
    const tail = match[6] ?? "";
    const noOp = tail.match(/(\d+) no-op \(unchanged\)/);
    const seed = tail.match(/· seed (\S+) \(([^)]+)\)/);
    const bytesIn = parseBytes(match[4]);
    const bytesOut = parseBytes(match[5]);
    out.push({
      passLabel: match[1] ?? "afterpack",
      files: Number(match[3]),
      ratioPercent: Math.round((bytesOut / bytesIn) * 100),
      unobfuscated: tail.includes("shipped UNOBFUSCATED"),
      noOp: noOp ? Number(noOp[1]) : 0,
      seed: seed ? seed[1] : null,
      seedOrigin: seed ? seed[2] : null,
    });
  }
  return out;
}

export function readBuildLog(fixture: Fixture): string {
  expect(
    existsSync(fixture.buildLog),
    `${fixture.name}: no build log at ${fixture.buildLog} — the build never ran through e2e/helpers/build-and-serve.mjs`,
  ).toBe(true);
  const log = readFileSync(fixture.buildLog, "utf8");
  expect(log.length, `${fixture.name}: the captured build log is empty`).toBeGreaterThan(0);
  return log;
}

export function expectObfuscationPass(
  log: string,
  name: string,
  expected: ObfuscationExpectation,
): ObfuscationPass[] {
  const passes = parseObfuscationPasses(log);
  expect(
    passes.length,
    `${name}: the build printed no "obfuscated N file(s)" summary — the AfterPack pass never ran`,
  ).toBeGreaterThanOrEqual(expected.passes);

  const cleartext = passes.filter((p) => p.unobfuscated).map((p) => p.passLabel);
  expect(cleartext, `${name}: ${cleartext.join(", ")} shipped UNOBFUSCATED files`).toEqual([]);

  const files = passes.reduce((n, p) => n + p.files, 0);
  expect(files, `${name}: the pass covered fewer files than expected`).toBeGreaterThanOrEqual(
    expected.minFiles,
  );

  const noOp = passes.reduce((n, p) => n + p.noOp, 0);
  expect(noOp, `${name}: all ${files} file(s) came back no-op (unchanged)`).toBeLessThan(files);

  for (const pass of passes) {
    expect(
      pass.ratioPercent,
      `${name}: ${pass.passLabel} emitted ${pass.ratioPercent}% of its input`,
    ).toBeGreaterThanOrEqual(expected.minRatioPercent);
  }
  return passes;
}

export function expectOneSeedAcrossLegs(log: string, name: string, legs: number): string {
  const passes = parseObfuscationPasses(log);
  expect(
    passes.map((p) => p.passLabel),
    `${name}: wrong number of obfuscation passes`,
  ).toHaveLength(legs);
  const missing = passes.filter((p) => p.seed === null).map((p) => p.passLabel);
  expect(missing, `${name}: no seed on the summary line of ${missing.join(", ")}`).toEqual([]);
  const seeds = [...new Set(passes.map((p) => p.seed as string))];
  expect(
    seeds,
    `${name}: the legs used different seeds — ${passes.map((p) => `${p.passLabel}=${p.seed}(${p.seedOrigin})`).join(" ")}`,
  ).toHaveLength(1);
  return seeds[0];
}
