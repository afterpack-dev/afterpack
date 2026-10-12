import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { expect } from "@playwright/test";
import {
  PROTECTION_RECEIPTS_DIR,
  protectionReceiptPath,
  STALE_OUTPUT_RECEIPT_FILE,
  verifyProtectionReceipt,
} from "../../packages/integration-utils/src/receipt.js";
import type { Fixture } from "./registry.js";

export function receiptOf(dir: string): string | null {
  const path = protectionReceiptPath(dir);
  return existsSync(path) ? path : null;
}

function shippedAfterpackFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.name === STALE_OUTPUT_RECEIPT_FILE || entry.name === ".afterpack") {
        found.push(full);
      } else if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else if (basename(current) === PROTECTION_RECEIPTS_DIR && entry.name.endsWith(".json")) {
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
  const receiptPath = receiptOf(distDir);
  expect(receiptPath, `${fixture.name}: no protection receipt for ${distDir}`).not.toBeNull();
  if (!receiptPath) return;
  const { receipt, problems } = verifyProtectionReceipt(receiptPath, distDir, readBuildId(distDir));
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
      readFileSync(mirrored).equals(readFileSync(join(distDir, entry.path))),
      `${fixture.name}: ${mirrored} differs from the obfuscated ${entry.path}`,
    ).toBe(true);
  }
}
