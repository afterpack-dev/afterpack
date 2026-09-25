import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REGISTRY = "https://registry.npmjs.org";
const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;
const DEPENDENCY_FIELDS = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
  "devDependencies",
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function listPackages() {
  return fs
    .readdirSync(path.join(ROOT, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(ROOT, "packages", entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, "package.json")))
    .map((dir) => ({
      dir,
      pkg: JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")),
    }))
    .filter(({ pkg }) => pkg.private !== true)
    .sort((a, b) => a.pkg.name.localeCompare(b.pkg.name));
}

function parseStable(version) {
  const m = STABLE.exec(version ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function max(versions) {
  return versions.filter(Boolean).reduce((best, v) => (compare(v, best) > 0 ? v : best), [0, 0, 0]);
}

function bump([major, minor, patch], kind) {
  if (kind === "major") return [major + 1, 0, 0];
  if (kind === "minor") return [major, minor + 1, 0];
  if (kind === "patch") return [major, minor, patch + 1];
  fail(`unknown bump '${kind}': expected patch, minor or major`);
}

function lastReleaseTag() {
  const refs = run("git", ["ls-remote", "--tags", "--refs", "origin", "v*"], { cwd: ROOT });
  return max(
    refs
      .split("\n")
      .map((line) => line.split("refs/tags/v")[1])
      .map(parseStable),
  );
}

function npmLatest(name) {
  const result = spawnSync("npm", ["view", name, "dist-tags.latest", "--registry", REGISTRY], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    if (/E404/.test(result.stderr)) return null;
    fail(`npm view ${name} failed:\n${result.stderr}`);
  }
  return result.stdout.trim() || null;
}

function nextVersion(kind, rc) {
  const floorRaw = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  const floor = parseStable(floorRaw.split("-")[0]) ?? fail(`invalid root version ${floorRaw}`);
  const tag = lastReleaseTag();
  const latest = parseStable(npmLatest("afterpack"));
  const released = max([tag, latest]);
  const next = max([floor, bump(released, kind)]).join(".");
  console.error(
    `last tag v${tag.join(".")}, npm latest ${latest ? latest.join(".") : "none"}, floor ${floor.join(".")} -> ${next}`,
  );
  if (!rc) return next;
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
    .slice(0, 13);
  return `${next}-rc.${stamp}`;
}

function extract(tarball, into) {
  fs.mkdirSync(into, { recursive: true });
  run("tar", ["-xzf", tarball, "-C", into]);
  return path.join(into, "package");
}

function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, base);
    return [path.relative(base, full).split(path.sep).join("/")];
  });
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

function normalizeManifest(file, workspaceNames) {
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  delete pkg.version;
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      if (workspaceNames.has(name)) pkg[field][name] = "workspace";
    }
  }
  return canonical(pkg);
}

function manifestChanges(local, published, workspaceNames) {
  const a = normalizeManifest(local, workspaceNames);
  const b = normalizeManifest(published, workspaceNames);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
    .map((key) => `${key}: ${JSON.stringify(b[key])} -> ${JSON.stringify(a[key])}`);
}

function diffTrees(local, published, workspaceNames) {
  const localFiles = new Set(walk(local));
  const publishedFiles = new Set(walk(published));
  const differences = [];
  for (const file of new Set([...localFiles, ...publishedFiles])) {
    if (!localFiles.has(file)) differences.push(`- ${file}`);
    else if (!publishedFiles.has(file)) differences.push(`+ ${file}`);
    else if (file === "package.json") {
      const keys = manifestChanges(
        path.join(local, file),
        path.join(published, file),
        workspaceNames,
      );
      for (const key of keys) differences.push(`~ ${file} ${key}`);
    } else if (
      !fs.readFileSync(path.join(local, file)).equals(fs.readFileSync(path.join(published, file)))
    ) {
      differences.push(`~ ${file}`);
    }
  }
  return differences.sort();
}

function singleTarball(dir) {
  const found = fs.readdirSync(dir).filter((f) => f.endsWith(".tgz"));
  if (found.length !== 1) fail(`expected one tarball in ${dir}, found ${found.length}`);
  return path.join(dir, found[0]);
}

function shippedChanges() {
  const packages = listPackages();
  const workspaceNames = new Set(packages.map(({ pkg }) => pkg.name));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "release-plan-"));
  const changed = [];
  try {
    for (const { dir, pkg } of packages) {
      const slot = path.join(work, pkg.name.replace("/", "__"));
      const localOut = path.join(slot, "local");
      const publishedOut = path.join(slot, "published");
      fs.mkdirSync(localOut, { recursive: true });
      fs.mkdirSync(publishedOut, { recursive: true });
      run("pnpm", ["pack", "--pack-destination", localOut], { cwd: dir });
      const latest = npmLatest(pkg.name);
      if (!latest) {
        console.log(`${pkg.name}: not on npm yet`);
        changed.push(pkg.name);
        continue;
      }
      run(
        "npm",
        [
          "pack",
          `${pkg.name}@${latest}`,
          "--pack-destination",
          publishedOut,
          "--registry",
          REGISTRY,
        ],
        { cwd: publishedOut },
      );
      const differences = diffTrees(
        extract(singleTarball(localOut), path.join(slot, "local-tree")),
        extract(singleTarball(publishedOut), path.join(slot, "published-tree")),
        workspaceNames,
      );
      if (differences.length === 0) {
        console.log(`${pkg.name}: same as ${latest}`);
        continue;
      }
      console.log(`${pkg.name}: differs from ${latest}`);
      for (const line of differences) console.log(`  ${line}`);
      changed.push(pkg.name);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  return changed;
}

function output(key, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

const [command, ...args] = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (command === "changed") {
  const changed = shippedChanges();
  console.log(
    changed.length ? `shipped change in ${changed.join(", ")}` : "no shipped change in any package",
  );
  output("changed", changed.length ? "true" : "false");
  output("packages", changed.join(" "));
} else if (command === "version") {
  const version = nextVersion(flag("bump") ?? "patch", args.includes("--rc"));
  console.log(version);
} else {
  fail("usage: node scripts/release-plan.mjs changed | version [--bump patch|minor|major] [--rc]");
}
