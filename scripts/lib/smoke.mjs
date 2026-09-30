import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const PRESETS = ["minify", "light", "medium", "hard", "extreme"];

export const SEEDS = [1, 2];

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

export const normalizeSource = (text) => text.replace(/\r\n/g, "\n");

export const resultKey = (fixture, preset, seed) => `${fixture}@${preset}#${seed}`;

export function listFixtures(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => /\.(?:cjs|mjs)$/.test(name))
    .sort();
}

export function readFixture(dir, name) {
  return normalizeSource(fs.readFileSync(path.join(dir, name), "utf8"));
}

export function hostIsMusl(platform = process.platform, report = process.report?.getReport?.()) {
  return platform === "linux" && !report?.header?.glibcVersionRuntime;
}

export function loadedAddons(cache) {
  return Object.keys(cache).filter((key) => key.endsWith(".node"));
}

export function isInside(file, dir) {
  const relative = path.relative(fs.realpathSync(dir), fs.realpathSync(file));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function runNode(args, cwd) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    timeout: 120 * 1000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: normalizeSource(result.stdout ?? ""),
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

export function compareManifests(golden, actual) {
  const problems = [];
  for (const section of ["inputs", "results"]) {
    const want = golden?.[section] ?? {};
    const have = actual?.[section] ?? {};
    for (const key of Object.keys(want).sort()) {
      if (!(key in have)) problems.push(`${section} ${key}: missing here`);
      else if (have[key] !== want[key]) {
        problems.push(`${section} ${key}: ${have[key]} here, ${want[key]} in the golden run`);
      }
    }
    for (const key of Object.keys(have).sort()) {
      if (!(key in want)) problems.push(`${section} ${key}: not in the golden run`);
    }
  }
  return problems;
}
