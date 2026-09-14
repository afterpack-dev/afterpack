import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { expect } from "@playwright/test";
import type { Fixture, FixtureTarget } from "./registry.js";

export function runBuild(
  fixture: Fixture,
  extraEnv: Record<string, string> = {},
  logPath: string = fixture.buildLog,
): string {
  const result = spawnSync(fixture.buildCommand, {
    cwd: fixture.dir,
    shell: true,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...fixture.env, ...extraEnv },
  });
  const log = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, log);
  expect(
    result.status,
    `${fixture.name}: \`${fixture.buildCommand}\` exited ${result.status}\n${log.slice(-4000)}`,
  ).toBe(0);
  return log;
}

const HASHED_OUTPUT = /\.(?:js|mjs|cjs|map)$/;

export function hashTargets(targets: FixtureTarget[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const { label, path } of targets) {
    expect(existsSync(path), `no build output at ${path} (target "${label}")`).toBe(true);
    const walk = (sub: string): void => {
      const entries = readdirSync(sub, { withFileTypes: true });
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        const full = join(sub, entry.name);
        const isDirectory =
          entry.isDirectory() || (!entry.isFile() && statSync(full).isDirectory());
        if (isDirectory) {
          walk(full);
        } else if (HASHED_OUTPUT.test(entry.name)) {
          out.set(
            `${label}:${relative(path, full)}`,
            createHash("sha256").update(readFileSync(full)).digest("hex"),
          );
        }
      }
    };
    walk(path);
  }
  return out;
}

function sameContents(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [file, hash] of a) if (b.get(file) !== hash) return false;
  return true;
}

export function expectObfuscatedAndDeterministic(fixture: Fixture): void {
  const obfuscated = hashTargets(fixture.targets);
  const baselineRoot = join(fixture.dir, ".afterpack-baseline");
  rmSync(baselineRoot, { recursive: true, force: true });

  runBuild(fixture, { AFTERPACK_build_autorun: "false" }, `${fixture.buildLog}.baseline`);
  const baselineTargets = fixture.targets.map((target) => ({
    label: target.label,
    path: join(baselineRoot, target.label),
  }));
  for (const [index, target] of fixture.targets.entries()) {
    cpSync(target.path, baselineTargets[index].path, { recursive: true });
  }
  const baseline = hashTargets(baselineTargets);
  rmSync(baselineRoot, { recursive: true, force: true });
  expect(
    sameContents(obfuscated, baseline),
    `${fixture.name}: the obfuscated build is byte-identical to the AFTERPACK_build_autorun=false baseline`,
  ).toBe(false);

  runBuild(fixture, {}, `${fixture.buildLog}.rebuild`);
  expect(
    sameContents(obfuscated, hashTargets(fixture.targets)),
    `${fixture.name}: two builds with the same seed produced different output`,
  ).toBe(true);
}
