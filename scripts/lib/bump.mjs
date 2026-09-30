import fs from "node:fs";
import path from "node:path";
import { CORE, STABLE } from "./engine.mjs";

export const DEPENDENCY_FIELDS = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
  "devDependencies",
];

export const COMPAT_FILE = "packages/integration-utils/src/compat.ts";

const MIN_CORE = /export const MIN_CORE_VERSION = "(\d+\.\d+\.\d+)";/;

export function triple(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  if (!m) throw new Error(`'${version}' is not a version`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareVersions(a, b) {
  const x = triple(a);
  const y = triple(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export function breakingLine(version) {
  const [major, minor] = triple(version);
  return major === 0 ? `0.${minor}` : `${major}`;
}

export function lineStart(version) {
  const [major, minor] = triple(version);
  return major === 0 ? `0.${minor}.0` : `${major}.0.0`;
}

const higher = (a, b) => (compareVersions(a, b) >= 0 ? a : b);

export function planEngineBump({ rootVersion, packages, minCore }, next) {
  if (!STABLE.test(next)) throw new Error(`'${next}' is not a stable version`);
  const pins = packages.flatMap(({ dir, pkg }) =>
    DEPENDENCY_FIELDS.filter((field) => pkg[field]?.[CORE]).map((field) => ({
      dir,
      field,
      range: pkg[field][CORE],
    })),
  );
  if (pins.length === 0) throw new Error(`no package depends on ${CORE}`);
  const current = pins.map((pin) => pin.range.replace(/^[~^]/, "")).reduce((a, b) => higher(a, b));
  if (compareVersions(next, current) < 0) {
    return { changed: false, reason: `already on ${current}, which is newer than ${next}` };
  }
  const range = `~${next}`;
  const lineChanged = breakingLine(next) !== breakingLine(current);
  const floor = lineChanged ? higher(rootVersion, lineStart(next)) : rootVersion;
  const nextMinCore = lineChanged ? higher(minCore, lineStart(next)) : minCore;
  const repins = pins.filter((pin) => pin.range !== range);
  const changed = repins.length > 0 || floor !== rootVersion || nextMinCore !== minCore;
  return {
    changed,
    reason: changed ? `${current} -> ${next}` : `already pinned to ${range}`,
    current,
    next,
    range,
    lineChanged,
    floor,
    minCore: nextMinCore,
    repins,
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function readRepo(root) {
  const packagesDir = path.join(root, "packages");
  const packages = fs
    .readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join("packages", entry.name))
    .filter((dir) => fs.existsSync(path.join(root, dir, "package.json")))
    .sort()
    .map((dir) => ({ dir, pkg: readJson(path.join(root, dir, "package.json")) }));
  const compat = fs.readFileSync(path.join(root, COMPAT_FILE), "utf8");
  const minCore = MIN_CORE.exec(compat)?.[1];
  if (!minCore) throw new Error(`${COMPAT_FILE} no longer declares MIN_CORE_VERSION`);
  return { rootVersion: readJson(path.join(root, "package.json")).version, packages, minCore };
}

export function applyEngineBump(root, plan) {
  const written = [];
  if (!plan.changed) return written;
  const repo = readRepo(root);
  const raiseFloor = plan.floor !== repo.rootVersion;
  if (raiseFloor) {
    const file = path.join(root, "package.json");
    writeJson(file, { ...readJson(file), version: plan.floor });
    written.push("package.json");
  }
  for (const { dir, pkg } of repo.packages) {
    let touched = false;
    for (const field of DEPENDENCY_FIELDS) {
      if (pkg[field]?.[CORE] && pkg[field][CORE] !== plan.range) {
        pkg[field][CORE] = plan.range;
        touched = true;
      }
    }
    if (raiseFloor && pkg.private !== true && pkg.version !== plan.floor) {
      pkg.version = plan.floor;
      touched = true;
    }
    if (touched) {
      writeJson(path.join(root, dir, "package.json"), pkg);
      written.push(path.join(dir, "package.json").split(path.sep).join("/"));
    }
  }
  if (plan.minCore !== repo.minCore) {
    const file = path.join(root, COMPAT_FILE);
    const text = fs.readFileSync(file, "utf8");
    fs.writeFileSync(
      file,
      text.replace(MIN_CORE, `export const MIN_CORE_VERSION = "${plan.minCore}";`),
    );
    written.push(COMPAT_FILE);
  }
  return written;
}
