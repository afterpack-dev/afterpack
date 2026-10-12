import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { AFTERPACK_DIR, afterpackRoot, ensureAfterpackGitignore } from "./artifacts.js";

export const PROTECTION_RECEIPTS_DIR = "receipts";

export const STALE_OUTPUT_RECEIPT_FILE = ".afterpack-protection.json";

export const PROTECTION_RECEIPT_SCHEMA = 1;

export interface ProtectionReceiptFile {
  path: string;
  sha256: string;
  transformed: boolean;
}

export type EngineSource = "local" | "cloud";

export interface ProtectionReceipt {
  schema: number;
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

function realOrResolved(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    const parent = dirname(resolved);
    return parent === resolved ? resolved : join(realOrResolved(parent), basename(resolved));
  }
}

function receiptKey(projectRoot: string, buildDir: string): string {
  const rel = relative(realOrResolved(projectRoot), realOrResolved(buildDir)).split(sep).join("/");
  return encodeURIComponent(rel === "" ? "." : rel).replace(/\*/g, "%2A");
}

export function protectionReceiptPath(afterpackDir: string, buildDir: string): string {
  const root = afterpackRoot(afterpackDir);
  return join(root, PROTECTION_RECEIPTS_DIR, `${receiptKey(dirname(root), buildDir)}.json`);
}

function selfAndAncestors(dir: string): string[] {
  const dirs: string[] = [];
  let current = resolve(dir);
  for (;;) {
    dirs.push(current);
    const parent = dirname(current);
    if (parent === current) return dirs;
    current = parent;
  }
}

export function findProtectionReceipt(
  buildDir: string,
  projectRoots: readonly string[] = [],
): string | null {
  for (const root of [...selfAndAncestors(buildDir), ...projectRoots]) {
    const afterpackDir = join(root, AFTERPACK_DIR);
    if (!existsSync(afterpackDir)) continue;
    const path = protectionReceiptPath(afterpackDir, buildDir);
    if (existsSync(path)) return path;
  }
  return null;
}

export function removeStaleOutputReceipt(buildDir: string, label: string): void {
  const path = join(buildDir, STALE_OUTPUT_RECEIPT_FILE);
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(
      `[${label}] could not remove the stale protection receipt ${path}, refusing to ship it: ${error}`,
    );
  }
}

export interface WriteProtectionReceiptInput {
  dir: string;
  afterpackDir: string;
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
    schema: PROTECTION_RECEIPT_SCHEMA,
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
  const path = protectionReceiptPath(input.afterpackDir, input.dir);
  mkdirSync(dirname(path), { recursive: true });
  ensureAfterpackGitignore(input.afterpackDir);
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
  return path;
}

export interface ProtectionVerification {
  receiptPath: string;
  receipt: ProtectionReceipt | null;
  problems: string[];
}

type ParsedReceipt =
  | { receipt: ProtectionReceipt; error?: undefined }
  | { error: string; newerSchema: number | null };

function parseReceipt(path: string): ParsedReceipt {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { error: `${path} is not valid JSON: ${reason}`, newerSchema: null };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: `${path} is not a protection receipt object`, newerSchema: null };
  }
  const receipt = raw as Partial<ProtectionReceipt>;
  const schema = receipt.schema;
  const newerSchema =
    typeof schema === "number" && Number.isInteger(schema) && schema > PROTECTION_RECEIPT_SCHEMA
      ? schema
      : null;
  const fail = (error: string): ParsedReceipt => ({ error, newerSchema });
  if (
    typeof schema !== "number" ||
    !Number.isInteger(schema) ||
    schema < PROTECTION_RECEIPT_SCHEMA
  ) {
    return fail(`${path} has schema ${String(schema)}, which this afterpack cannot read`);
  }
  if (!Array.isArray(receipt.files)) return fail(`${path} lists no files`);
  if (!receipt.files.every(isReceiptFile)) return fail(`${path} lists a file entry it cannot read`);
  return { receipt: receipt as ProtectionReceipt };
}

function isReceiptFile(value: unknown): value is ProtectionReceiptFile {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<ProtectionReceiptFile>;
  return typeof entry.path === "string" && typeof entry.sha256 === "string";
}

export const DIAG_RECEIPT_UNREADABLE = "DIAG_RECEIPT_UNREADABLE";

export class UnreadableReceiptError extends Error {
  readonly code = DIAG_RECEIPT_UNREADABLE;
  readonly receiptPath: string;
  readonly schema: number;

  constructor(message: string, receiptPath: string, schema: number) {
    super(message);
    this.name = "UnreadableReceiptError";
    this.receiptPath = receiptPath;
    this.schema = schema;
  }
}

export function verifyProtectionReceipt(
  receiptPath: string,
  dir: string,
  expectedBuildId?: string | null,
): ProtectionVerification {
  if (!existsSync(receiptPath)) {
    return { receiptPath, receipt: null, problems: [`no protection receipt at ${receiptPath}`] };
  }
  const result = parseReceipt(receiptPath);
  if (result.error !== undefined) {
    return { receiptPath, receipt: null, problems: [result.error] };
  }
  const parsed = result.receipt;

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

function findOwnReceipt(startDir: string, afterpackDir: string): string | null {
  for (const dir of selfAndAncestors(startDir)) {
    const path = protectionReceiptPath(afterpackDir, dir);
    if (existsSync(path)) return path;
  }
  return null;
}

interface AlreadyObfuscatedInputs {
  receiptPath: string;
  files: string[];
}

export function detectAlreadyObfuscatedInputs(
  files: readonly string[],
  startDir: string,
  afterpackDir: string,
  bytesByPath?: ReadonlyMap<string, Uint8Array>,
  prefix: (message: string) => string = (m) => m,
): AlreadyObfuscatedInputs | null {
  const receiptPath = findOwnReceipt(startDir, afterpackDir);
  if (!receiptPath) return null;
  const result = parseReceipt(receiptPath);
  if (result.error !== undefined) {
    const schema = result.newerSchema;
    if (schema === null) return null;
    throw new UnreadableReceiptError(
      prefix(
        `${receiptPath} was written by a newer AfterPack (receipt schema ${schema}), so this ` +
          "version cannot tell whether these files are already obfuscated — update afterpack, " +
          "or rebuild from source and delete the receipt before running it again.",
      ),
      receiptPath,
      schema,
    );
  }
  const outputHashes = new Set(
    result.receipt.files.filter((f) => f.transformed !== false).map((f) => f.sha256),
  );
  if (outputHashes.size === 0) return null;
  const matches = files.filter((file) => {
    const bytes = bytesByPath?.get(file);
    if (bytes !== undefined) return outputHashes.has(sha256OfBytes(bytes));
    return existsSync(file) && outputHashes.has(sha256Of(file));
  });
  return matches.length > 0 ? { receiptPath, files: matches } : null;
}
