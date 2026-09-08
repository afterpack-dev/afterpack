import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const SOURCE_MAPPING_URL_RE = /\/\/[#@]\s*sourceMappingURL=(\S+)\s*$/gm;

const SOURCE_MAPPING_URL_LINE_RE = /^[ \t]*\/\/[#@]\s*sourceMappingURL=\S+[ \t]*\r?\n?/gm;

export function withSourceMappingURL(code: string, url: string | null): string {
  const stripped = code.replace(SOURCE_MAPPING_URL_LINE_RE, "");
  if (url == null) return stripped;
  const separator = stripped.length > 0 && !stripped.endsWith("\n") ? "\n" : "";
  return `${stripped}${separator}//# sourceMappingURL=${url}\n`;
}

export function extractSourceMappingURL(code: string): string | null {
  let last: string | null = null;
  for (const match of code.matchAll(SOURCE_MAPPING_URL_RE)) {
    last = match[1];
  }
  return last;
}

export function isRemoteSourceMappingURL(url: string): boolean {
  return /^https?:\/\//i.test(url) || url.startsWith("//");
}

export function decodeDataUri(url: string): string | null {
  if (!url.startsWith("data:")) return null;
  const comma = url.indexOf(",");
  if (comma === -1) return null;
  const meta = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  try {
    if (/;base64/i.test(meta)) {
      return Buffer.from(payload, "base64").toString("utf8");
    }
    return decodeURIComponent(payload);
  } catch {
    return null;
  }
}

export function discoverInputSourceMap(jsPath: string, code?: string): string | null {
  const adjacent = `${jsPath}.map`;
  if (existsSync(adjacent)) {
    try {
      return readFileSync(adjacent, "utf8");
    } catch {}
  }

  let source = code;
  if (source == null) {
    try {
      source = readFileSync(jsPath, "utf8");
    } catch {
      return null;
    }
  }

  const url = extractSourceMappingURL(source);
  if (url == null) return null;

  if (url.startsWith("data:")) {
    return decodeDataUri(url);
  }

  if (isRemoteSourceMappingURL(url)) {
    return null;
  }

  let mapPath: string;
  try {
    mapPath = isAbsolute(url) ? url : resolve(dirname(jsPath), decodeURIComponent(url));
  } catch {
    return null;
  }
  if (!existsSync(mapPath)) return null;
  try {
    return readFileSync(mapPath, "utf8");
  } catch {
    return null;
  }
}
