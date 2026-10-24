import { createHash } from "node:crypto";
import {
  closeSync,
  type Dirent,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { ensureAfterpackGitignore } from "./artifacts.js";
import {
  AFTERPACK_DIR,
  AfterpackFilesError,
  type AfterpackHome,
  afterpackHome,
  DIAG_AFTERPACK_DIR_IN_OUTPUT,
  DIAG_RECEIPT_UNWRITABLE,
  realPath,
} from "./home.js";

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
  buildDir: string;
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

const MAX_KEY_BYTES = 180;

const HASHED_KEY_PREFIX_BYTES = 120;

function buildDirOf(home: AfterpackHome): string {
  const rel = relative(home.projectRoot, home.buildDir).split(sep).join("/");
  return rel === "" ? "." : rel;
}

function receiptKey(buildDir: string): string {
  const encoded = encodeURIComponent(buildDir).replace(/\*/g, "%2A").replace(/~/g, "%7E");
  if (Buffer.byteLength(encoded) <= MAX_KEY_BYTES) return encoded;
  const prefix = encoded.slice(0, HASHED_KEY_PREFIX_BYTES).replace(/%[0-9A-F]?$/, "");
  const digest = createHash("sha256").update(buildDir, "utf8").digest("hex").slice(0, 16);
  return `${prefix}~${digest}`;
}

function receiptsDirOf(home: AfterpackHome): string {
  return join(home.dir, PROTECTION_RECEIPTS_DIR);
}

function receiptPathIn(home: AfterpackHome): string {
  return join(receiptsDirOf(home), `${receiptKey(buildDirOf(home))}.json`);
}

export type HomeTarget = string | AfterpackHome;

function homeOf(target: HomeTarget): AfterpackHome {
  return typeof target === "string" ? afterpackHome(target) : target;
}

export function buildDirKey(target: HomeTarget): string {
  return receiptKey(buildDirOf(homeOf(target)));
}

export function protectionReceiptPath(target: HomeTarget): string {
  return receiptPathIn(homeOf(target));
}

export function prepareProtectionReceipt(target: HomeTarget, label: string): string {
  const home = homeOf(target);
  const path = receiptPathIn(home);
  try {
    mkdirSync(dirname(path), { recursive: true });
    ensureAfterpackGitignore(home.dir);
    const existed = existsSync(path);
    closeSync(openSync(path, "a"));
    if (!existed) unlinkSync(path);
  } catch (error) {
    throw new AfterpackFilesError(
      DIAG_RECEIPT_UNWRITABLE,
      `[${label}] cannot write the protection receipt ${path}, so no file was rewritten: ${error}`,
      `Make ${dirname(path)} a writable directory, then build again.`,
    );
  }
  return path;
}

function entriesOf(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function removeStaleReceipt(path: string, label: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(
      `[${label}] could not remove the stale protection receipt ${path}, refusing to ship it: ${error}`,
    );
  }
}

function refuseShippedAfterpackDir(path: string, buildDir: string, label: string): never {
  throw new AfterpackFilesError(
    DIAG_AFTERPACK_DIR_IN_OUTPUT,
    `[${label}] found ${path} inside the build output ${buildDir}. It holds AfterPack backups, ` +
      "receipts or Protection Maps, which must never ship.",
    `Delete ${path}, then build again.`,
  );
}

interface SweepContext {
  buildDir: string;
  label: string;
  ownHome: string | null;
}

function sweepDir(dir: string, context: SweepContext, recursive: boolean): void {
  for (const entry of entriesOf(dir)) {
    const full = join(dir, entry.name);
    if (entry.name === STALE_OUTPUT_RECEIPT_FILE) {
      removeStaleReceipt(full, context.label);
    } else if (entry.isDirectory()) {
      if (entry.name === AFTERPACK_DIR) {
        if (context.ownHome !== null && realPath(full) === context.ownHome) continue;
        refuseShippedAfterpackDir(full, context.buildDir, context.label);
      }
      if (!recursive || entry.name === "node_modules") continue;
      sweepDir(full, context, true);
    }
  }
}

export function sweepOutputTree(
  buildDir: string,
  walkedDir: string | null,
  label: string,
  ownHome: AfterpackHome | null = null,
): void {
  const context = { buildDir, label, ownHome: ownHome?.strong ? realPath(ownHome.dir) : null };
  const walksBuildDir = walkedDir !== null && realPath(walkedDir) === realPath(buildDir);
  sweepDir(buildDir, context, walksBuildDir);
  if (walkedDir !== null && !walksBuildDir) sweepDir(walkedDir, context, true);
}

export interface WriteProtectionReceiptInput {
  dir: string;
  home?: AfterpackHome;
  tool: string;
  engine: EngineSource | null;
  engineVersion: string | null;
  seed: number | string;
  seedOrigin: string;
  bundler: string;
  buildId: string | null;
  files: string[];
  transformed: readonly string[];
  fileTarget?: boolean;
}

function keptEntries(path: string, dir: string, replaced: Set<string>): ProtectionReceiptFile[] {
  if (!existsSync(path)) return [];
  const previous = parseReceipt(path);
  if (previous.error !== undefined || previous.receipt.schema !== PROTECTION_RECEIPT_SCHEMA) {
    return [];
  }
  return previous.receipt.files.filter(
    (entry) => !replaced.has(entry.path) && existsSync(join(dir, entry.path)),
  );
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
    buildDir: ".",
    files: input.files
      .map((file) => ({
        path: receiptPathOf(input.dir, file),
        sha256: sha256Of(file),
        transformed: transformed.has(file),
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
  const home = input.home ?? afterpackHome(input.dir);
  receipt.buildDir = buildDirOf(home);
  const path = receiptPathIn(home);
  const shippedSource =
    input.fileTarget !== true &&
    receipt.files.length > 0 &&
    receipt.files.every((entry) => !entry.transformed);
  if (!shippedSource) {
    const replaced = new Set(receipt.files.map((entry) => entry.path));
    receipt.files = [...keptEntries(path, input.dir, replaced), ...receipt.files].sort((a, b) =>
      a.path.localeCompare(b.path),
    );
  }
  mkdirSync(dirname(path), { recursive: true });
  ensureAfterpackGitignore(home.dir);
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

function receiptsIn(home: AfterpackHome): string[] {
  const dir = receiptsDirOf(home);
  return entriesOf(dir)
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(dir, entry.name))
    .sort();
}

export interface LocatedReceipt {
  receiptPath: string;
  dir: string;
  copiedFrom: string | null;
}

function filesByName(dir: string): Map<string, string[]> {
  const byName = new Map<string, string[]>();
  const walk = (current: string, rel: string): void => {
    for (const entry of entriesOf(current)) {
      if (entry.name === "node_modules" || entry.name === AFTERPACK_DIR) continue;
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(join(current, entry.name), childRel);
      else if (entry.isFile())
        byName.set(entry.name, [...(byName.get(entry.name) ?? []), childRel]);
    }
  };
  walk(dir, "");
  return byName;
}

interface CopyMatch extends LocatedReceipt {
  hashesMatch: boolean;
  prefix: string;
}

function copyMatches(dir: string, home: AfterpackHome, skip: Set<string>): CopyMatch[] {
  const receipts = receiptsIn(home).filter((path) => !skip.has(path));
  if (receipts.length === 0) return [];
  const byName = filesByName(dir);
  const matches: CopyMatch[] = [];
  for (const receiptPath of receipts) {
    const parsed = parseReceipt(receiptPath);
    if (parsed.error !== undefined || parsed.receipt.files.length === 0) continue;
    const { files, buildDir } = parsed.receipt;
    const first = files[0].path;
    for (const rel of byName.get(first.split("/").pop() ?? first) ?? []) {
      if (rel !== first && !rel.endsWith(`/${first}`)) continue;
      const prefix = rel.slice(0, rel.length - first.length);
      const copyDir = join(dir, ...prefix.split("/").filter(Boolean));
      if (!files.every((entry) => existsSync(join(copyDir, entry.path)))) continue;
      matches.push({
        receiptPath,
        dir: copyDir,
        copiedFrom: typeof buildDir === "string" ? join(home.projectRoot, buildDir) : null,
        hashesMatch: files.every((entry) => sha256Of(join(copyDir, entry.path)) === entry.sha256),
        prefix,
      });
    }
  }
  return matches.sort(
    (a, b) =>
      Number(b.hashesMatch) - Number(a.hashesMatch) ||
      a.prefix.length - b.prefix.length ||
      a.receiptPath.localeCompare(b.receiptPath),
  );
}

export interface LocateReceiptOptions {
  copies?: boolean;
}

export function locateProtectionReceipt(
  dir: string,
  options: LocateReceiptOptions = {},
): LocatedReceipt | null {
  const homes = [afterpackHome(dir), afterpackHome(dir, { fileTarget: true })];
  const exact = [...new Set(homes.map(receiptPathIn))];
  const found = exact.find((path) => existsSync(path));
  if (found) return { receiptPath: found, dir, copiedFrom: null };
  if (options.copies === false) return null;
  const best = copyMatches(dir, homes[0], new Set(exact))[0];
  return best
    ? { receiptPath: best.receiptPath, dir: best.dir, copiedFrom: best.copiedFrom }
    : null;
}

interface AlreadyObfuscatedInputs {
  receiptPath: string;
  files: string[];
}

export function detectAlreadyObfuscatedInputs(
  files: readonly string[],
  startDir: HomeTarget,
  bytesByPath?: ReadonlyMap<string, Uint8Array>,
  prefix: (message: string) => string = (m) => m,
): AlreadyObfuscatedInputs | null {
  const hashOf = (file: string): string | null => {
    const bytes = bytesByPath?.get(file);
    if (bytes !== undefined) return sha256OfBytes(bytes);
    return existsSync(file) ? sha256Of(file) : null;
  };
  let hashes: Map<string, string | null> | null = null;
  for (const receiptPath of receiptsIn(homeOf(startDir))) {
    const result = parseReceipt(receiptPath);
    if (result.error !== undefined) {
      const schema = result.newerSchema;
      if (schema === null) continue;
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
    if (outputHashes.size === 0) continue;
    hashes ??= new Map(files.map((file) => [file, hashOf(file)] as const));
    const matches = files.filter((file) => {
      const hash = hashes?.get(file);
      return hash != null && outputHashes.has(hash);
    });
    if (matches.length > 0) return { receiptPath, files: matches };
  }
  return null;
}
