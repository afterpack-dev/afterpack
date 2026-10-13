import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-write.js";

const SRI_ATTR = /\b(src|href)\s*=\s*"([^"]+)"[^>]*\bintegrity\s*=\s*"(sha(?:256|384|512))-[^"]*"/g;
const SRI_ATTR_REVERSED =
  /\bintegrity\s*=\s*"(sha(?:256|384|512))-[^"]*"[^>]*\b(src|href)\s*=\s*"([^"]+)"/g;

function digest(
  bytes: Uint8Array | string,
  algo: "sha1" | "sha256" | "sha384" | "sha512",
  enc: "base64" | "hex",
): string {
  return createHash(algo).update(bytes).digest(enc);
}

function fileFor(baseDir: string, ref: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//")) return null;
  const path = ref.split(/[?#]/)[0];
  if (path === "") return null;
  return join(baseDir, path);
}

function planHtmlIntegrity(browserDir: string, planned: Map<string, string>): void {
  for (const html of htmlFilesUnder(browserDir)) {
    const text = readFileSync(html, "utf8");
    const rewrite = (algo: "sha256" | "sha384" | "sha512", ref: string, match: string): string => {
      const file = fileFor(browserDir, ref);
      if (file === null || !existsSync(file)) return match;
      const hash = digest(readFileSync(file), algo, "base64");
      return match.replace(
        /integrity\s*=\s*"sha(?:256|384|512)-[^"]*"/,
        `integrity="${algo}-${hash}"`,
      );
    };
    let next = text.replace(SRI_ATTR, (match, _attr, ref, algo) =>
      rewrite(algo as "sha256", ref as string, match),
    );
    next = next.replace(SRI_ATTR_REVERSED, (match, algo, _attr, ref) =>
      rewrite(algo as "sha256", ref as string, match),
    );
    if (next !== text) planned.set(html, next);
  }
}

function htmlFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    if (entry.endsWith(".html")) out.push(join(dir, entry));
  }
  return out;
}

const PLUGIN_LABEL = "@afterpack/angular";

function planNgswHashTable(browserDir: string, label: string, planned: Map<string, string>): void {
  const ngsw = join(browserDir, "ngsw.json");
  if (!existsSync(ngsw)) return;
  const config = JSON.parse(readFileSync(ngsw, "utf8")) as { hashTable?: Record<string, string> };
  const table = config.hashTable;
  if (!table) return;
  for (const url of Object.keys(table)) {
    const file = join(browserDir, url.replace(/^\//, ""));
    if (!existsSync(file) || !statSync(file).isFile()) {
      throw new Error(
        `${label}: ngsw.json names ${url}, which is not in the browser output after ` +
          "obfuscation. AfterPack cannot recompute the service worker hash table. Rebuild, or " +
          "disable the service worker for this build.",
      );
    }
    table[url] = digest(planned.get(file) ?? readFileSync(file), "sha1", "hex");
  }
  planned.set(ngsw, `${JSON.stringify(config, null, 2)}\n`);
}

export function planAngularIntegrity(
  outputRoot: string,
  browserDir: string,
  label = PLUGIN_LABEL,
): Map<string, string> {
  const refusal = angularServerManifestRefusal(outputRoot);
  if (refusal !== null) {
    throw new Error(
      `${label}: ${refusal} — obfuscate only the browser output, or remove ` +
        "@afterpack/angular from the SSR build.",
    );
  }
  const planned = new Map<string, string>();
  planHtmlIntegrity(browserDir, planned);
  planNgswHashTable(browserDir, label, planned);
  return planned;
}

export function recomputeAngularIntegrity(
  outputRoot: string,
  browserDir: string,
  label = PLUGIN_LABEL,
): void {
  for (const [path, text] of planAngularIntegrity(outputRoot, browserDir, label)) {
    writeFileAtomic(path, text);
  }
}

export function angularServerManifestRefusal(outputRoot: string): string | null {
  const serverDir = join(outputRoot, "server");
  if (!existsSync(serverDir)) return null;
  for (const entry of readdirSync(serverDir)) {
    if (!/angular-app-(?:engine-)?manifest\.mjs$/.test(entry)) continue;
    const text = readFileSync(join(serverDir, entry), "utf8");
    if (/\bhash\s*:\s*['"`]/.test(text) || /\bintegrity\s*:/.test(text)) {
      return (
        `${entry} embeds asset hashes that AfterPack cannot recompute after renaming and ` +
        "obfuscating the browser output, so the SSR ETags would be stale. This Angular server " +
        "build is not supported"
      );
    }
  }
  return null;
}
