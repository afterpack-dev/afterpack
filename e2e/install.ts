import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fixtureDirs, REPO_ROOT, selectedFixtures } from "./helpers/registry.js";

const requestedConcurrency = Number(process.env.AFTERPACK_E2E_INSTALL_CONCURRENCY ?? 4);
const CONCURRENCY =
  Number.isFinite(requestedConcurrency) && requestedConcurrency >= 1
    ? Math.floor(requestedConcurrency)
    : 4;
const STAMP = ".afterpack-e2e-lock.sha256";

const dirs = fixtureDirs(selectedFixtures());
const failures: string[] = [];
let reused = 0;

function lockDigest(dir: string): string {
  return createHash("sha256")
    .update(readFileSync(join(dir, "package-lock.json")))
    .update(process.version)
    .digest("hex");
}

function upToDate(dir: string): boolean {
  const stamp = join(dir, "node_modules", STAMP);
  return existsSync(stamp) && readFileSync(stamp, "utf8") === lockDigest(dir);
}

function install(dir: string): Promise<void> {
  const label = relative(REPO_ROOT, dir);
  if (!existsSync(join(dir, "package-lock.json"))) {
    failures.push(`${label}: no package-lock.json`);
    return Promise.resolve();
  }
  if (upToDate(dir)) {
    reused += 1;
    console.log(`reused    ${label}`);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const child = spawn("npm", ["ci", "--no-audit", "--no-fund"], {
      cwd: dir,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    let spawnError: Error | null = null;
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (code) => {
      if (spawnError) {
        failures.push(`${label}: could not run npm ci — ${String(spawnError)}`);
        console.error(`FAILED    ${label}`);
      } else if (code === 0) {
        writeFileSync(join(dir, "node_modules", STAMP), lockDigest(dir));
        console.log(`installed ${label}`);
      } else {
        failures.push(`${label}: npm ci exited ${code}\n${output.slice(-2000)}`);
        console.error(`FAILED    ${label}`);
      }
      resolve();
    });
  });
}

const queue = [...dirs];
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let dir = queue.shift(); dir !== undefined; dir = queue.shift()) await install(dir);
  }),
);

if (failures.length > 0) {
  console.error(`\n${failures.length} fixture install(s) failed:\n${failures.join("\n\n")}`);
  process.exit(1);
}
console.log(`\n${dirs.length} e2e fixture(s) ready, ${reused} reused an up-to-date install`);
