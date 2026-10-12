import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { expect } from "@playwright/test";
import {
  type LocatedReceipt,
  locateProtectionReceipt,
  PROTECTION_RECEIPTS_DIR,
  STALE_OUTPUT_RECEIPT_FILE,
  verifyProtectionReceipt,
} from "../../packages/integration-utils/src/receipt.js";
import { type Fixture, REPO_ROOT } from "./registry.js";

export function receiptOf(dir: string): LocatedReceipt | null {
  return locateProtectionReceipt(dir);
}

export function expectVerifyPasses(fixture: Fixture, deployDir: string): void {
  const verify = spawnSync(
    process.execPath,
    [join(REPO_ROOT, "packages", "cli", "dist", "cli.js"), "verify", deployDir],
    { cwd: fixture.dir, encoding: "utf8" },
  );
  const output = `${verify.stdout}${verify.stderr}`;
  expect(verify.status, `${fixture.name}: afterpack verify ${deployDir}\n${output}`).toBe(0);
  expect(output).toContain("Verified");
}

function shippedAfterpackFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.name === STALE_OUTPUT_RECEIPT_FILE || entry.name === ".afterpack") {
        found.push(full);
      }
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else if (
        basename(current) === PROTECTION_RECEIPTS_DIR &&
        basename(dirname(current)) === ".afterpack" &&
        entry.name.endsWith(".json")
      ) {
        found.push(full);
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return found;
}

function readBuildId(distDir: string): string | null {
  const path = join(distDir, "BUILD_ID");
  return existsSync(path) ? readFileSync(path, "utf8").trim() : null;
}

export function expectNoPostbuildScript(fixture: Fixture): void {
  const scripts: Record<string, string> =
    JSON.parse(readFileSync(join(fixture.dir, "package.json"), "utf8")).scripts ?? {};
  const wired = Object.entries(scripts)
    .filter(([name, body]) => name === "postbuild" || body.includes("afterpack-next"))
    .map(([name]) => name);
  expect(
    wired,
    `${fixture.name}: AfterPack is invoked outside \`next build\` (${wired.join(", ")})`,
  ).toEqual([]);
}

export function expectProtectionReceipt(
  fixture: Fixture,
  distDir: string,
  mirrorDir?: string,
): void {
  const located = receiptOf(distDir);
  expect(located, `${fixture.name}: no protection receipt for ${distDir}`).not.toBeNull();
  if (!located) return;
  const { receipt, problems } = verifyProtectionReceipt(
    located.receiptPath,
    located.dir,
    readBuildId(located.dir),
  );
  expect(problems, `${fixture.name}: protection receipt problems`).toEqual([]);
  expect(receipt, `${fixture.name}: no protection receipt for ${distDir}`).not.toBeNull();
  for (const dir of mirrorDir ? [distDir, mirrorDir] : [distDir]) {
    expect(
      shippedAfterpackFiles(dir),
      `${fixture.name}: AfterPack files sit in ${dir}, where they would ship`,
    ).toEqual([]);
  }
  if (!receipt || !mirrorDir) return;
  for (const entry of receipt.files) {
    const mirrored = join(mirrorDir, entry.path);
    expect(
      existsSync(mirrored),
      `${fixture.name}: ${entry.path} was obfuscated but never reached ${mirrorDir}`,
    ).toBe(true);
    expect(
      readFileSync(mirrored).equals(readFileSync(join(located.dir, entry.path))),
      `${fixture.name}: ${mirrored} differs from the obfuscated ${entry.path}`,
    ).toBe(true);
  }
}
