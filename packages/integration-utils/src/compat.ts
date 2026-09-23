import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CloudNotice,
  type SafeNotice,
  sanitizeNotices,
  sanitizeServerText,
} from "./notices.js";
import { findUpward } from "./paths.js";

export const MIN_CORE_VERSION = "0.1.0";

export const CORE_PACKAGE = "@afterpack/core";

export interface ClientIdentity {
  packageName: string | null;
  packageVersion: string | null;
  coreVersion: string | null;
}

const VERSION_PATTERN = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:[-+][0-9A-Za-z.+-]{1,64})?$/;

const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,63}$/;

export function safeVersionString(value: unknown): string | null {
  return typeof value === "string" && VERSION_PATTERN.test(value) ? value : null;
}

function readPackageJson(path: string): { name?: unknown; version?: unknown } | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as { name?: unknown; version?: unknown };
  } catch {
    return null;
  }
}

function ownPackage(moduleUrl: string | URL): { name: string; version: string } | null {
  try {
    const path = findUpward(dirname(fileURLToPath(moduleUrl)), "package.json");
    const pkg = path ? readPackageJson(path) : null;
    if (!pkg || typeof pkg.name !== "string" || !PACKAGE_NAME_PATTERN.test(pkg.name)) return null;
    const version = safeVersionString(pkg.version);
    return version ? { name: pkg.name, version } : null;
  } catch {
    return null;
  }
}

function installedCoreVersion(moduleUrl: string | URL): string | null {
  try {
    const path = createRequire(moduleUrl).resolve(`${CORE_PACKAGE}/package.json`);
    const pkg = readPackageJson(path);
    return pkg?.name === CORE_PACKAGE ? safeVersionString(pkg.version) : null;
  } catch {
    return null;
  }
}

export function resolveClientIdentity(moduleUrl: string | URL): ClientIdentity {
  const own = ownPackage(moduleUrl);
  return {
    packageName: own?.name ?? null,
    packageVersion: own?.version ?? null,
    coreVersion: installedCoreVersion(moduleUrl),
  };
}

export function clientString(identity: ClientIdentity | null | undefined): string | null {
  if (!identity?.packageName || !identity.packageVersion) return null;
  return `${identity.packageName}/${identity.packageVersion}`;
}

export function releaseTriple(version: string | null | undefined): [number, number, number] | null {
  if (typeof version !== "string") return null;
  const match = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:[-+].*)?$/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isBelowVersion(version: string | null | undefined, minimum: string): boolean {
  const have = releaseTriple(version);
  const need = releaseTriple(minimum);
  if (!have || !need) return false;
  for (let i = 0; i < 3; i++) {
    if (have[i] !== need[i]) return have[i] < need[i];
  }
  return false;
}

export const CLI_PACKAGE = "afterpack";

export function updateCommand(
  identity: ClientIdentity | null | undefined,
  minVersion?: string | null,
): string {
  const core = `${CORE_PACKAGE}@${safeVersionString(minVersion) ?? "latest"}`;
  const name = identity?.packageName;
  const install =
    name && name !== CORE_PACKAGE ? `npm install ${name}@latest ${core}` : `npm install ${core}`;
  return name === CLI_PACKAGE
    ? `${install} (or, without a local install: npx ${CLI_PACKAGE}@latest)`
    : install;
}

export class CoreVersionError extends Error {
  readonly code = "CORE_VERSION_UNSUPPORTED";
  readonly installed: string;
  readonly minimum: string;
  readonly fix: string;

  constructor(message: string, installed: string, minimum: string, fix: string) {
    super(message);
    this.name = "CoreVersionError";
    this.installed = installed;
    this.minimum = minimum;
    this.fix = fix;
  }
}

export function assertSupportedCore(
  identity: ClientIdentity | null | undefined,
  prefix: (message: string) => string = (m) => m,
): void {
  const installed = identity?.coreVersion ?? null;
  if (installed === null || !isBelowVersion(installed, MIN_CORE_VERSION)) return;
  const fix = updateCommand(identity);
  throw new CoreVersionError(
    prefix(
      `${CORE_PACKAGE} ${installed} is older than ${MIN_CORE_VERSION}, the oldest engine this ` +
        `integration supports — update @afterpack/core: ${fix}`,
    ),
    installed,
    MIN_CORE_VERSION,
    fix,
  );
}

export const CLOUD_UPGRADE_REQUIRED = "AFTERPACK_CLOUD_UPGRADE_REQUIRED";
export const CLOUD_SUNSET = "AFTERPACK_CLOUD_SUNSET";
export const CLOUD_API = "AFTERPACK_CLOUD_API";

export type CloudErrorKind = "upgradeRequired" | "sunset" | "api";

const KIND_BY_CODE: Readonly<Record<string, CloudErrorKind>> = {
  [CLOUD_UPGRADE_REQUIRED]: "upgradeRequired",
  [CLOUD_SUNSET]: "sunset",
  [CLOUD_API]: "api",
};

const API_CODE_LIMIT = 64;

export interface CloudErrorBody {
  code: string | null;
  message: string;
  details: Record<string, unknown> | null;
  notices: CloudNotice[] | null;
}

export class CloudApiError extends Error {
  readonly code: string;
  readonly kind: CloudErrorKind;
  readonly apiCode: string | null;
  readonly apiMessage: string;
  readonly details: Record<string, unknown> | null;
  readonly notices: SafeNotice[];
  readonly minVersion: string | null;
  readonly fix: string;

  constructor(input: {
    message: string;
    code: string;
    kind: CloudErrorKind;
    apiCode: string | null;
    apiMessage: string;
    details: Record<string, unknown> | null;
    notices: SafeNotice[];
    minVersion: string | null;
    fix: string;
    cause: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "CloudApiError";
    this.code = input.code;
    this.kind = input.kind;
    this.apiCode = input.apiCode;
    this.apiMessage = input.apiMessage;
    this.details = input.details;
    this.notices = input.notices;
    this.minVersion = input.minVersion;
    this.fix = input.fix;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCloudErrorMessage(raw: string): CloudErrorBody {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed)) {
      const code = sanitizeServerText(parsed.code, API_CODE_LIMIT);
      return {
        code: code === "" ? null : code,
        message: sanitizeServerText(parsed.message),
        details: isRecord(parsed.details) ? parsed.details : null,
        notices: Array.isArray(parsed.notices) ? (parsed.notices as CloudNotice[]) : null,
      };
    }
  } catch {}
  return { code: null, message: sanitizeServerText(raw), details: null, notices: null };
}

function describeCloudFailure(
  kind: CloudErrorKind,
  body: CloudErrorBody,
  minVersion: string | null,
  identity: ClientIdentity | null | undefined,
): string {
  const server = body.message ? ` Server: ${body.message}` : "";
  if (kind === "api") {
    if (!body.code && body.message.startsWith("cloud obfuscation failed")) return body.message;
    const code = body.code ? `${body.code}: ` : "";
    return `cloud obfuscation failed: ${code}${body.message || "the API refused the request"}`;
  }
  const installed = identity?.coreVersion ? ` (installed ${identity.coreVersion})` : "";
  const fix = updateCommand(identity, minVersion);
  if (kind === "sunset") {
    return (
      `the AfterPack cloud API this ${CORE_PACKAGE}${installed} talks to has been retired — ` +
      `update: ${fix}.${server}`
    );
  }
  const floor = minVersion ? ` ${minVersion} or newer` : " a newer release";
  return (
    `the AfterPack cloud API requires ${CORE_PACKAGE}${floor}${installed} — update: ${fix}.` +
    server
  );
}

export function toCloudApiError(
  error: unknown,
  options: {
    identity?: ClientIdentity | null;
    prefix?: (message: string) => string;
  } = {},
): CloudApiError | null {
  if (!isRecord(error) && !(error instanceof Error)) return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string") return null;
  const kind = KIND_BY_CODE[code];
  if (!kind) return null;
  const rawMessage = (error as { message?: unknown }).message;
  const body = parseCloudErrorMessage(typeof rawMessage === "string" ? rawMessage : "");
  const minVersion = safeVersionString(body.details?.minVersion);
  const prefix = options.prefix ?? ((m: string) => m);
  return new CloudApiError({
    message: prefix(describeCloudFailure(kind, body, minVersion, options.identity)),
    code,
    kind,
    apiCode: body.code,
    apiMessage: body.message,
    details: body.details,
    notices: sanitizeNotices(body.notices),
    minVersion,
    fix: updateCommand(options.identity, minVersion),
    cause: error,
  });
}
