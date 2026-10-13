import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect, test } from "@playwright/test";
import { runBuild, withFixtureDirLock } from "./build.js";
import { currentFixture } from "./current.js";
import { readExpectations } from "./expectations.js";
import type { Fixture } from "./registry.js";

export interface HashedNamesExpectation {
  pattern: string;
  minRenamed: number;
}

export const SECOND_SEED = "913572468";
const SCRIPT_OUTPUT = /\.(?:[cm]?js|map)$/;

export type Snapshot = Map<string, string>;

export function snapshotTargets(fixture: Fixture): Snapshot {
  const out: Snapshot = new Map();
  for (const { label, path } of fixture.targets) {
    expect(existsSync(path), `${fixture.name}: no build output at ${path}`).toBe(true);
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory() || (!entry.isFile() && statSync(full).isDirectory())) {
          walk(full);
          continue;
        }
        const name = `${label}:${relative(path, full).split(sep).join("/")}`;
        out.set(name, createHash("sha256").update(readFileSync(full)).digest("hex"));
      }
    };
    walk(path);
  }
  return out;
}

export function nameReuseProblems(
  builds: Record<string, Snapshot>,
  hashed: (name: string) => boolean,
): string[] {
  const problems: string[] = [];
  const labels = Object.keys(builds);
  const names = new Set(labels.flatMap((label) => [...builds[label].keys()]));
  for (const name of [...names].sort()) {
    if (!hashed(name)) continue;
    const seen = labels.filter((label) => builds[label].has(name));
    const digests = new Set(seen.map((label) => builds[label].get(name)));
    if (digests.size > 1) problems.push(`${name} names different bytes in ${seen.join(", ")}`);
  }
  return problems;
}

type HashedNamesDeclaration =
  | HashedNamesExpectation
  | Record<string, HashedNamesExpectation | null>
  | null;

export function hashedNamesOf(fixture: Fixture): HashedNamesExpectation | null {
  const declared = (readExpectations(fixture) as { hashedNames?: HashedNamesDeclaration })
    .hashedNames;
  expect(declared, `${fixture.name}: expectations.json must declare hashedNames`).not.toBe(
    undefined,
  );
  if (declared == null) return null;
  if (typeof declared.pattern === "string") return declared as HashedNamesExpectation;
  const own = (declared as Record<string, HashedNamesExpectation | null>)[fixture.name];
  expect(own, `${fixture.name}: hashedNames names no entry for this fixture`).not.toBe(undefined);
  return own ?? null;
}

export function expectHashedNamesFollowBytes(fixture: Fixture): void {
  const spec = hashedNamesOf(fixture);
  test.skip(!spec, `${fixture.name} ships no content-hashed file names`);
  if (!spec) return;
  const pattern = new RegExp(spec.pattern);
  const log = (step: string) => `${fixture.buildLog}.hashed-names-${step}`;
  const builds = withFixtureDirLock(fixture.dir, () => {
    const seeded = snapshotTargets(fixture);
    runBuild(
      fixture,
      { AFTERPACK_E2E_SEED: SECOND_SEED, AFTERPACK_seed: SECOND_SEED },
      log("seed"),
    );
    const reseeded = snapshotTargets(fixture);
    runBuild(fixture, { AFTERPACK_build_autorun: "false" }, log("plain"));
    const plain = snapshotTargets(fixture);
    runBuild(fixture, {}, log("restore"));
    const restored = snapshotTargets(fixture);
    return { seeded, reseeded, plain, restored };
  });

  expect(
    [...builds.restored].filter(
      ([name, digest]) =>
        (SCRIPT_OUTPUT.test(name) || pattern.test(name)) && builds.seeded.get(name) !== digest,
    ),
    `${fixture.name}: rebuilding with the fixture's seed did not restore the build byte for byte`,
  ).toEqual([]);
  expect(
    nameReuseProblems(
      { plain: builds.plain, seeded: builds.seeded, reseeded: builds.reseeded },
      (name) => pattern.test(name),
    ),
    `${fixture.name}: a content-hashed name must always name the same bytes`,
  ).toEqual([]);
  const renamed = [...builds.seeded.keys()].filter(
    (name) => pattern.test(name) && !builds.plain.has(name),
  );
  expect(
    renamed.length,
    `${fixture.name}: expected at least ${spec.minRenamed} obfuscated file(s) matching ` +
      `${spec.pattern} to leave the plain build's names behind`,
  ).toBeGreaterThanOrEqual(spec.minRenamed);
}

export function hashedNamesTest(): void {
  test("every content-hashed file name follows its obfuscated bytes", { tag: "@node" }, () => {
    expectHashedNamesFollowBytes(currentFixture());
  });
}
