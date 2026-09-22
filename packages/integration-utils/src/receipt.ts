import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { findUpward } from "./paths.js";

export const PROTECTION_RECEIPT_FILE = ".afterpack-protection.json";

export interface ProtectionReceiptFile {
  path: string;
  sha256: string;
  transformed: boolean;
}

export type EngineSource = "local" | "cloud";

export interface ProtectionReceipt {
  schema: 1;
  tool: string;
  engine: EngineSource | null;
  engineVersion: string | null;
  seed: string;
  seedOrigin: string;
  bundler: string;
  buildId: string | null;
  files: ProtectionReceiptFile[];
}

function sha256OfBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256Of(path: string): string {
  return sha256OfBytes(readFileSync(path));
}

function receiptPathOf(dir: string, file: string): string {
  return relative(dir, file).split(sep).join("/");
}

export interface WriteProtectionReceiptInput {
  dir: string;
  tool: string;
  engine: EngineSource | null;
  engineVersion: string | null;
  seed: number | string;
  seedOrigin: string;
  bundler: string;
  buildId: string | null;
  files: string[];
  transformed: readonly string[];
}

export function writeDeferredProtectionReceipt(
  deferred: WriteProtectionReceiptInput,
): string | null {
  const survivingFiles = deferred.files.filter((file) => existsSync(file));
  if (survivingFiles.length === 0) return null;
  return writeProtectionReceipt({ ...deferred, files: survivingFiles });
}

export function writeProtectionReceipt(input: WriteProtectionReceiptInput): string {
  const transformed = new Set(input.transformed);
  const receipt: ProtectionReceipt = {
    schema: 1,
    tool: input.tool,
    engine: input.engine,
    engineVersion: input.engineVersion,
    seed: String(input.seed),
    seedOrigin: input.seedOrigin,
    bundler: input.bundler,
    buildId: input.buildId,
    files: input.files
      .map((file) => ({
        path: receiptPathOf(input.dir, file),
        sha256: sha256Of(file),
        transformed: transformed.has(file),
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
  const path = join(input.dir, PROTECTION_RECEIPT_FILE);
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
  return path;
}

export interface ProtectionVerification {
  receiptPath: string;
  receipt: ProtectionReceipt | null;
  problems: string[];
}

function parseReceipt(path: string): ProtectionReceipt | string {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    return `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return `${path} is not a protection receipt object`;
  }
  const receipt = raw as Partial<ProtectionReceipt>;
  if (receipt.schema !== 1) {
    return `${path} has schema ${String(receipt.schema)}, which this afterpack cannot read`;
  }
  if (!Array.isArray(receipt.files)) return `${path} lists no files`;
  return receipt as ProtectionReceipt;
}

export function verifyProtectionReceipt(
  dir: string,
  expectedBuildId?: string | null,
): ProtectionVerification {
  const receiptPath = join(dir, PROTECTION_RECEIPT_FILE);
  if (!existsSync(receiptPath)) {
    return { receiptPath, receipt: null, problems: [`no protection receipt at ${receiptPath}`] };
  }
  const parsed = parseReceipt(receiptPath);
  if (typeof parsed === "string") {
    return { receiptPath, receipt: null, problems: [parsed] };
  }

  const problems: string[] = [];
  if (expectedBuildId != null && parsed.buildId !== expectedBuildId) {
    problems.push(
      `receipt is for build ${String(parsed.buildId)}, but this output is build ${expectedBuildId} — ` +
        "the tree was rebuilt without the AfterPack wrapper",
    );
  }
  if (parsed.files.length === 0) {
    problems.push("receipt records zero obfuscated files");
  }
  const transformed = parsed.files.filter((f) => f.transformed !== false).length;
  if (parsed.files.length > 0 && transformed === 0) {
    problems.push(
      `receipt lists ${parsed.files.length} file(s) but the engine changed NONE of them — ` +
        "this build shipped its source (check `paths.exclude` and AFTERPACK_paths_exclude)",
    );
  }
  for (const entry of parsed.files) {
    const file = join(dir, entry.path);
    if (!existsSync(file)) {
      problems.push(`${entry.path}: obfuscated at build time, missing now`);
      continue;
    }
    if (sha256Of(file) !== entry.sha256) {
      problems.push(`${entry.path}: content changed since it was obfuscated`);
    }
  }
  return { receiptPath, receipt: parsed, problems };
}

function findReceiptDir(startDir: string): string | null {
  const receiptPath = findUpward(startDir, PROTECTION_RECEIPT_FILE);
  return receiptPath ? dirname(receiptPath) : null;
}

interface AlreadyObfuscatedInputs {
  receiptPath: string;
  files: string[];
}

export function detectAlreadyObfuscatedInputs(
  files: readonly string[],
  startDir: string,
  bytesByPath?: ReadonlyMap<string, Uint8Array>,
): AlreadyObfuscatedInputs | null {
  const dir = findReceiptDir(startDir);
  if (!dir) return null;
  const receiptPath = join(dir, PROTECTION_RECEIPT_FILE);
  const parsed = parseReceipt(receiptPath);
  if (typeof parsed === "string") return null;
  const outputHashes = new Set(parsed.files.map((f) => f.sha256));
  if (outputHashes.size === 0) return null;
  const matches = files.filter((file) => {
    const bytes = bytesByPath?.get(file);
    if (bytes !== undefined) return outputHashes.has(sha256OfBytes(bytes));
    return existsSync(file) && outputHashes.has(sha256Of(file));
  });
  return matches.length > 0 ? { receiptPath, files: matches } : null;
}
