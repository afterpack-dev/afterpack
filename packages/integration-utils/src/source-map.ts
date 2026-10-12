import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";

const SOURCE_MAPPING_URL_RE = /\/\/[#@]\s*sourceMappingURL=(\S+)\s*$/gm;

const SOURCE_MAPPING_URL_LINE_RE = /^[ \t]*\/\/[#@]\s*sourceMappingURL=\S+[ \t]*\r?\n?/gm;

const CSS_SOURCE_MAPPING_URL_RE = /[ \t]*\/\*[#@]\s*sourceMappingURL=[^\s*]+\s*\*\/\s*$/;

export function withSourceMappingURL(code: string, url: string | null): string {
  const stripped = code.replace(SOURCE_MAPPING_URL_LINE_RE, "");
  if (url == null) return stripped;
  const separator = stripped.length > 0 && !stripped.endsWith("\n") ? "\n" : "";
  return `${stripped}${separator}//# sourceMappingURL=${url}\n`;
}

export function withoutCssSourceMappingURL(css: string): string {
  return css.replace(CSS_SOURCE_MAPPING_URL_RE, "");
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

function localSourceMapPath(jsPath: string, url: string): string | null {
  if (url.startsWith("data:") || isRemoteSourceMappingURL(url)) return null;
  const path = url.replace(/[?#].*$/, "");
  try {
    return isAbsolute(path) ? path : resolve(dirname(jsPath), decodeURIComponent(path));
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

  const mapPath = localSourceMapPath(jsPath, url);
  if (mapPath == null || !existsSync(mapPath)) return null;
  try {
    return readFileSync(mapPath, "utf8");
  } catch {
    return null;
  }
}

export function bundlerSourceMapPaths(jsPath: string, code: string, root: string): string[] {
  const candidates = [`${jsPath}.map`];
  for (const match of code.matchAll(SOURCE_MAPPING_URL_RE)) {
    const url = match[1];
    const local = localSourceMapPath(jsPath, url);
    if (local != null) candidates.push(local);
    if (url.startsWith("/") && !url.startsWith("//")) {
      try {
        candidates.push(resolve(root, `.${decodeURIComponent(url.replace(/[?#].*$/, ""))}`));
      } catch {}
    }
  }
  return containedSourceMaps(candidates, root);
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

export function withinRealDir(dir: string, root: string): boolean {
  const rootReal = realpathOrNull(root);
  const real = realpathOrNull(dir);
  if (rootReal == null || real == null) return false;
  if (real === rootReal) return true;
  return real.startsWith(rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`);
}

export function containedSourceMaps(paths: Iterable<string>, root: string): string[] {
  const found = new Set<string>();
  for (const path of paths) {
    if (!path.endsWith(".map")) continue;
    const lexical = resolve(path);
    if (!withinRealDir(dirname(lexical), root)) continue;
    try {
      const stat = lstatSync(lexical);
      if (stat.isFile() || stat.isSymbolicLink()) found.add(lexical);
    } catch {}
  }
  return [...found];
}

export function removeSourceMaps(paths: Iterable<string>, label: string): number {
  let removed = 0;
  for (const path of paths) {
    try {
      unlinkSync(path);
      removed++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(
        `[${label}] could not remove the source map ${path}, refusing to ship it: ${error}`,
      );
    }
  }
  return removed;
}

export function stripCssSourceMappingURLs(paths: Iterable<string>): number {
  let stripped = 0;
  for (const path of paths) {
    let css: string;
    try {
      css = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const without = withoutCssSourceMappingURL(css);
    if (without === css) continue;
    writeFileSync(path, without);
    stripped++;
  }
  return stripped;
}
