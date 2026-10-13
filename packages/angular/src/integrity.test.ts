import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recomputeAngularIntegrity } from "./integrity.js";

let root: string;
let browserDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "afterpack-angular-integrity-"));
  browserDir = join(root, "browser");
  mkdirSync(browserDir, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function sha(algo: "sha256" | "sha384", bytes: string, enc: "hex" | "base64"): string {
  return createHash(algo).update(bytes).digest(enc);
}

describe("recomputeAngularIntegrity ngsw.json", () => {
  it("recomputes every hashTable entry from the obfuscated bytes", () => {
    writeFileSync(join(browserDir, "main-ABCD2345.js"), "OBF main");
    writeFileSync(
      join(browserDir, "ngsw.json"),
      JSON.stringify({ hashTable: { "/main-ABCD2345.js": "0".repeat(40) } }),
    );
    recomputeAngularIntegrity(root, browserDir);
    const table = JSON.parse(readFileSync(join(browserDir, "ngsw.json"), "utf8")).hashTable;
    expect(table["/main-ABCD2345.js"]).toBe(sha("sha256", "OBF main", "hex").slice(0, 40));
  });

  it("refuses when ngsw.json names a file the obfuscated output no longer has", () => {
    writeFileSync(
      join(browserDir, "ngsw.json"),
      JSON.stringify({ hashTable: { "/missing-ABCD2345.js": "0".repeat(40) } }),
    );
    expect(() => recomputeAngularIntegrity(root, browserDir)).toThrow(/service worker hash/);
  });
});

describe("recomputeAngularIntegrity subresource integrity", () => {
  it("recomputes the integrity attribute from the obfuscated bytes, in either attribute order", () => {
    writeFileSync(join(browserDir, "main-ABCD2345.js"), "OBF main");
    writeFileSync(join(browserDir, "poly-WXYZ6789.js"), "OBF poly");
    writeFileSync(
      join(browserDir, "index.html"),
      '<script src="main-ABCD2345.js" integrity="sha384-STALE"></script>' +
        '<script integrity="sha384-STALE" src="poly-WXYZ6789.js"></script>',
    );
    recomputeAngularIntegrity(root, browserDir);
    const html = readFileSync(join(browserDir, "index.html"), "utf8");
    expect(html).toContain(`integrity="sha384-${sha("sha384", "OBF main", "base64")}"`);
    expect(html).toContain(`integrity="sha384-${sha("sha384", "OBF poly", "base64")}"`);
    expect(html).not.toContain("STALE");
  });
});

describe("recomputeAngularIntegrity server manifest", () => {
  it("refuses a server manifest that embeds asset hashes it cannot recompute", () => {
    const serverDir = join(root, "server");
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(
      join(serverDir, "angular-app-manifest.mjs"),
      'export default { assets: { "index.csr.html": { size: 10, hash: "abc123", text: async () => "" } } };',
    );
    expect(() => recomputeAngularIntegrity(root, browserDir)).toThrow(/SSR|server build/i);
  });

  it("leaves a server dir without embedded hashes alone", () => {
    const serverDir = join(root, "server");
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(join(serverDir, "server.mjs"), 'export const handler = () => "ok";');
    expect(() => recomputeAngularIntegrity(root, browserDir)).not.toThrow();
  });
});
