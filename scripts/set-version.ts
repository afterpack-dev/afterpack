import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parse(version: string): number[] {
  const m = SEMVER.exec(version);
  if (!m) fail(`invalid semver: ${version}`);
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? 0 : 1];
}

function isDowngrade(next: string, current: string): boolean {
  const a = parse(next);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

function listPackages(): string[] {
  const packagesDir = path.join(ROOT, "packages");
  return fs
    .readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}`)
    .filter((dir) => {
      const file = path.join(ROOT, dir, "package.json");
      if (!fs.existsSync(file)) return false;
      const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as { private?: boolean };
      return pkg.private !== true;
    })
    .sort();
}

function writeVersion(file: string, version: string): void {
  const raw = fs.readFileSync(file, "utf8");
  const indent = /^(\t+| +)"/m.exec(raw)?.[1] ?? "  ";
  const pkg = JSON.parse(raw) as Record<string, unknown>;
  pkg.version = version;
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, indent)}\n`);
}

const args = process.argv.slice(2);
const force = args.includes("--force");
const flagIndex = args.indexOf("--version");
const version = flagIndex >= 0 ? args[flagIndex + 1] : args.find((a) => !a.startsWith("--"));
if (!version) fail("usage: tsx scripts/set-version.ts --version <version> [--force]");
parse(version);

const rootPkg = path.join(ROOT, "package.json");
const current = (JSON.parse(fs.readFileSync(rootPkg, "utf8")) as { version: string }).version;
if (!force && isDowngrade(version, current)) {
  fail(`refusing downgrade ${current} -> ${version} (use --force)`);
}

writeVersion(rootPkg, version);
console.log(`package.json -> ${version}`);

for (const dir of listPackages()) {
  writeVersion(path.join(ROOT, dir, "package.json"), version);
  console.log(`${dir}/package.json -> ${version}`);
}
