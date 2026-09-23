export interface CloudNotice {
  severity: string;
  code: string;
  message: string;
  url?: string;
}

export type NoticeSeverity = "info" | "warning" | "error";

export interface SafeNotice {
  severity: NoticeSeverity;
  code: string;
  message: string;
  url: string | null;
}

export const NOTICE_MESSAGE_LIMIT = 500;

export const NOTICE_LIMIT = 5;

const NOTICE_CODE_LIMIT = 64;

const NOTICE_HOSTS: ReadonlySet<string> = new Set(["afterpack.dev", "www.afterpack.dev"]);

const ESC = 0x1b;
const BEL = 0x07;
const C1_CSI = 0x9b;
const C1_OSC = 0x9d;

function isControl(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

function isInvisibleFormat(code: number): boolean {
  return (
    code === 0x061c ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2069) ||
    code === 0xfeff
  );
}

function skipCsi(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    i += 1;
    if (c >= 0x40 && c <= 0x7e) return i;
  }
  return i;
}

function skipOsc(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === BEL) return i + 1;
    if (c === ESC) return text.charCodeAt(i + 1) === 0x5c ? i + 2 : i + 1;
    if (c === 0x9c) return i + 1;
    i += 1;
  }
  return i;
}

function stripTerminalControls(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === ESC) {
      const next = text.charCodeAt(i + 1);
      if (next === 0x5b) i = skipCsi(text, i + 2);
      else if (next === 0x5d) i = skipOsc(text, i + 2);
      else i += Number.isNaN(next) ? 1 : 2;
      continue;
    }
    if (c === C1_CSI) {
      i = skipCsi(text, i + 1);
      continue;
    }
    if (c === C1_OSC) {
      i = skipOsc(text, i + 1);
      continue;
    }
    if (isControl(c)) {
      out += c === 0x09 || c === 0x0a || c === 0x0d ? " " : "";
      i += 1;
      continue;
    }
    if (c === 0x2028 || c === 0x2029) {
      out += " ";
      i += 1;
      continue;
    }
    if (isInvisibleFormat(c)) {
      i += 1;
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}

export function sanitizeServerText(value: unknown, limit = NOTICE_MESSAGE_LIMIT): string {
  if (typeof value !== "string") return "";
  const clean = stripTerminalControls(value).replace(/\s+/g, " ").trim();
  const chars = Array.from(clean);
  return chars.length > limit ? chars.slice(0, limit).join("") : clean;
}

export function sanitizeNoticeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!NOTICE_HOSTS.has(url.hostname) || url.port !== "") return null;
  if (url.username !== "" || url.password !== "") return null;
  const href = url.href;
  return href.length <= NOTICE_MESSAGE_LIMIT ? href : null;
}

function noticeSeverity(value: unknown): NoticeSeverity {
  if (value === "info") return "info";
  if (value === "error" || value === "critical") return "error";
  return "warning";
}

export function sanitizeNotices(raw: unknown): SafeNotice[] {
  if (!Array.isArray(raw)) return [];
  const out: SafeNotice[] = [];
  for (const entry of raw) {
    if (out.length >= NOTICE_LIMIT) break;
    if (typeof entry !== "object" || entry === null) continue;
    const n = entry as Record<string, unknown>;
    const message = sanitizeServerText(n.message);
    if (message === "") continue;
    out.push({
      severity: noticeSeverity(n.severity),
      code: sanitizeServerText(n.code, NOTICE_CODE_LIMIT),
      message,
      url: sanitizeNoticeUrl(n.url),
    });
  }
  return out;
}

export function formatNotice(notice: SafeNotice): string {
  const head = notice.severity === "info" ? "AfterPack notice" : `AfterPack ${notice.severity}`;
  const tail = notice.url ? ` ${notice.url}` : "";
  return `${head}: ${notice.message}${tail}`;
}

export interface NoticeLogger {
  log(message: string): void;
  warn?(message: string): void;
}

export function reportNotices(
  raw: unknown,
  logger: NoticeLogger,
  prefix: (message: string) => string = (m) => m,
): SafeNotice[] {
  const notices = sanitizeNotices(raw);
  for (const notice of notices) {
    const line = prefix(formatNotice(notice));
    if (notice.severity === "info" || !logger.warn) logger.log(line);
    else logger.warn(line);
  }
  return notices;
}
