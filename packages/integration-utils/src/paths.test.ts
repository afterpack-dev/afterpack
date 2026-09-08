import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COMBINED_PROTECTION_MAP_NAME,
  combinedProtectionMapPath,
  resolveArtifactPaths,
  shortHash,
} from "./paths.js";

describe("shortHash", () => {
  it("is a stable 8-char hex digest of the content", () => {
    const h = shortHash('console.log("x");');
    expect(h).toMatch(/^[0-9a-f]{8}$/);
    expect(shortHash('console.log("x");')).toBe(h);
    expect(shortHash("different")).not.toBe(h);
  });
});

describe("resolveArtifactPaths", () => {
  const out = join("build", "chunks", "main.js");

  it("single-file mode: .map + per-file .protectionMap.html + .backup.<hash>.<ext>", () => {
    const p = resolveArtifactPaths(out, "single", "abc12345");
    expect(p.mapPath).toBe(`${out}.map`);
    expect(p.protectionMapPath).toBe(join("build", "chunks", "main.protectionMap.html"));
    expect(p.backupPath).toBe(join("build", "chunks", "main.backup.abc12345.js"));
  });

  it("directory mode: no per-file PM (combined instead), keeps .map + backup", () => {
    const p = resolveArtifactPaths(out, "directory", "abc12345");
    expect(p.mapPath).toBe(`${out}.map`);
    expect(p.protectionMapPath).toBeNull();
    expect(p.backupPath).toBe(join("build", "chunks", "main.backup.abc12345.js"));
  });

  it("framework mode: same next-to-file shape as directory, no per-file PM", () => {
    const p = resolveArtifactPaths(out, "framework", "deadbeef");
    expect(p.protectionMapPath).toBeNull();
    expect(p.backupPath).toBe(join("build", "chunks", "main.backup.deadbeef.js"));
  });

  it("omits the backup path when no content hash is supplied", () => {
    const p = resolveArtifactPaths(out, "single");
    expect(p.backupPath).toBeNull();
  });

  it("preserves a .mjs extension in the backup name", () => {
    const p = resolveArtifactPaths(join("d", "page.mjs"), "single", "0badf00d");
    expect(p.backupPath).toBe(join("d", "page.backup.0badf00d.mjs"));
  });
});

describe("combinedProtectionMapPath", () => {
  it("is protectionMap.html inside the build dir", () => {
    expect(combinedProtectionMapPath(join("app", ".next"))).toBe(
      join("app", ".next", COMBINED_PROTECTION_MAP_NAME),
    );
    expect(COMBINED_PROTECTION_MAP_NAME).toBe("protectionMap.html");
  });
});
