import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ASTRO_POST_BUILD_PLACEHOLDERS = [
  "@@ASTRO_MANIFEST_REPLACE@@",
  "@@ASTRO-LINKS@@",
  "@@ASTRO-STYLES@@",
  "$$server-islands-map$$",
  "$$server-islands-name-map$$",
];

const PLACEHOLDER_SOURCE = "@@ASTRO[A-Za-z0-9_-]*@@|\\$\\$server-islands[a-z-]*\\$\\$";

export function findAstroPlaceholders(distDir: string): string[] {
  const found = new Set<string>();
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) {
        let text: string;
        try {
          text = readFileSync(path, "utf8");
        } catch {
          continue;
        }
        for (const match of text.matchAll(new RegExp(PLACEHOLDER_SOURCE, "g"))) {
          found.add(match[0]);
        }
      }
    }
  };
  walk(distDir);
  return [...found];
}

export function assertPlaceholdersPinned(found: string[]): void {
  const pinned = new Set(ASTRO_POST_BUILD_PLACEHOLDERS);
  const missing = found.filter((placeholder) => !pinned.has(placeholder));
  if (missing.length > 0) {
    throw new Error(
      "@afterpack/astro cannot safely obfuscate the Astro server build: this Astro version " +
        `substitutes post-build placeholder(s) AfterPack does not preserve (${missing.join(", ")}), ` +
        "so they would be encoded away. Update @afterpack/astro, or add them to strings.preserveLiterals.",
    );
  }
}
