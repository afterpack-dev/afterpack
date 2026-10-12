import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import {
  findProtectionReceipt,
  STALE_OUTPUT_RECEIPT_FILE,
  verifyProtectionReceipt,
} from "../../packages/integration-utils/src/receipt.js";
import type { Fixture } from "./registry.js";

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
  const receiptPath = findProtectionReceipt(distDir);
  expect(receiptPath, `${fixture.name}: no protection receipt for ${distDir}`).not.toBeNull();
  if (!receiptPath) return;
  const { receipt, problems } = verifyProtectionReceipt(receiptPath, distDir, readBuildId(distDir));
  expect(problems, `${fixture.name}: protection receipt problems`).toEqual([]);
  expect(receipt, `${fixture.name}: no protection receipt for ${distDir}`).not.toBeNull();
  for (const dir of mirrorDir ? [distDir, mirrorDir] : [distDir]) {
    expect(
      existsSync(join(dir, STALE_OUTPUT_RECEIPT_FILE)),
      `${fixture.name}: a protection receipt sits in ${dir}, where it would ship`,
    ).toBe(false);
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
