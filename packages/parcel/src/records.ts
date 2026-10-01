import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureAfterpackGitignore, type ProtectionReceipt } from "@afterpack/integration-utils";

export interface BundleRecord {
  tool: string;
  engine: ProtectionReceipt["engine"];
  engineVersion: string | null;
  seed: string;
  seedOrigin: string;
  transformed: boolean;
}

function afterpackDirOf(projectRoot: string): string {
  return join(projectRoot, ".afterpack");
}

function recordsDirOf(projectRoot: string): string {
  return join(afterpackDirOf(projectRoot), "parcel");
}

function recordPathOf(projectRoot: string, bundleId: string): string {
  return join(recordsDirOf(projectRoot), `${bundleId}.json`);
}

export function writeBundleRecord(
  projectRoot: string,
  bundleId: string,
  record: BundleRecord,
): void {
  const path = recordPathOf(projectRoot, bundleId);
  mkdirSync(recordsDirOf(projectRoot), { recursive: true });
  ensureAfterpackGitignore(afterpackDirOf(projectRoot));
  writeFileSync(path, `${JSON.stringify(record)}\n`);
}

export function clearBundleRecord(projectRoot: string, bundleId: string): void {
  rmSync(recordPathOf(projectRoot, bundleId), { force: true });
}

export function clearBundleRecords(projectRoot: string): void {
  rmSync(recordsDirOf(projectRoot), { recursive: true, force: true });
}

export function readBundleRecord(projectRoot: string, bundleId: string): BundleRecord | null {
  try {
    const raw = JSON.parse(readFileSync(recordPathOf(projectRoot, bundleId), "utf8")) as unknown;
    if (raw === null || typeof raw !== "object") return null;
    const record = raw as Partial<BundleRecord>;
    if (typeof record.tool !== "string" || typeof record.transformed !== "boolean") return null;
    return record as BundleRecord;
  } catch {
    return null;
  }
}
