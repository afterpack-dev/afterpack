import { createHash } from "node:crypto";
import { join, parse } from "node:path";

export type ArtifactMode = "single" | "directory" | "framework";

export const COMBINED_PROTECTION_MAP_NAME = "protectionMap.html";

export function shortHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 8);
}

export interface ArtifactPaths {
  mapPath: string;
  protectionMapPath: string | null;
  backupPath: string | null;
}

export function resolveArtifactPaths(
  outPath: string,
  mode: ArtifactMode,
  contentHash?: string,
): ArtifactPaths {
  const { dir, name, ext } = parse(outPath);
  const stem = join(dir, name);

  return {
    mapPath: `${outPath}.map`,
    protectionMapPath: mode === "single" ? `${stem}.protectionMap.html` : null,
    backupPath: contentHash != null ? `${stem}.backup.${contentHash}${ext}` : null,
  };
}

export function combinedProtectionMapPath(buildDir: string): string {
  return join(buildDir, COMBINED_PROTECTION_MAP_NAME);
}
