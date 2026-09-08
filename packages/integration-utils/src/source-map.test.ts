import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decodeDataUri,
  discoverInputSourceMap,
  extractSourceMappingURL,
  isRemoteSourceMappingURL,
} from "./source-map.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "afterpack-sourcemap-test-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const MAP = JSON.stringify({ version: 3, sources: ["a.ts"], mappings: "AAAA" });

describe("extractSourceMappingURL", () => {
  it("returns the last sourceMappingURL comment", () => {
    const code =
      "var a=1;\n//# sourceMappingURL=first.map\nvar b=2;\n//# sourceMappingURL=second.map\n";
    expect(extractSourceMappingURL(code)).toBe("second.map");
  });
  it("supports the legacy //@ form and returns null when absent", () => {
    expect(extractSourceMappingURL("var a=1;\n//@ sourceMappingURL=legacy.map")).toBe("legacy.map");
    expect(extractSourceMappingURL("var a=1;")).toBeNull();
  });
});

describe("isRemoteSourceMappingURL", () => {
  it("flags http/https and protocol-relative, not paths or data URIs", () => {
    expect(isRemoteSourceMappingURL("https://cdn.example.com/x.map")).toBe(true);
    expect(isRemoteSourceMappingURL("http://x/y.map")).toBe(true);
    expect(isRemoteSourceMappingURL("//cdn.example.com/x.map")).toBe(true);
    expect(isRemoteSourceMappingURL("./x.map")).toBe(false);
    expect(isRemoteSourceMappingURL("data:application/json,{}")).toBe(false);
  });
});

describe("decodeDataUri", () => {
  it("decodes base64 and percent-encoded payloads, rejects non-data URIs", () => {
    const b64 = `data:application/json;base64,${Buffer.from(MAP, "utf8").toString("base64")}`;
    expect(decodeDataUri(b64)).toBe(MAP);
    const pct = `data:application/json,${encodeURIComponent(MAP)}`;
    expect(decodeDataUri(pct)).toBe(MAP);
    expect(decodeDataUri("./x.map")).toBeNull();
  });
});

describe("discoverInputSourceMap", () => {
  it("prefers an adjacent <file>.map on disk", () => {
    const js = join(dir, "adjacent.js");
    writeFileSync(js, "var a=1;\n//# sourceMappingURL=other.map\n");
    writeFileSync(`${js}.map`, MAP);
    writeFileSync(join(dir, "other.map"), JSON.stringify({ version: 3, sources: ["other"] }));
    expect(discoverInputSourceMap(js)).toBe(MAP);
  });

  it("resolves a relative sourceMappingURL comment against the file's dir", () => {
    const js = join(dir, "rel.js");
    writeFileSync(js, "var a=1;\n//# sourceMappingURL=rel-map.map\n");
    writeFileSync(join(dir, "rel-map.map"), MAP);
    expect(discoverInputSourceMap(js)).toBe(MAP);
  });

  it("returns null when a relative comment points at a missing file (never throws)", () => {
    const js = join(dir, "missing.js");
    writeFileSync(js, "var a=1;\n//# sourceMappingURL=does-not-exist.map\n");
    expect(discoverInputSourceMap(js)).toBeNull();
  });

  it("decodes an inline data: URI sourceMappingURL", () => {
    const js = join(dir, "data.js");
    const b64 = Buffer.from(MAP, "utf8").toString("base64");
    writeFileSync(js, `var a=1;\n//# sourceMappingURL=data:application/json;base64,${b64}\n`);
    expect(discoverInputSourceMap(js)).toBe(MAP);
  });

  it("NEVER network-fetches a remote URL — treats http(s)/protocol-relative as none", () => {
    const js = join(dir, "remote.js");
    writeFileSync(js, "var a=1;\n//# sourceMappingURL=https://evil.example.com/app.js.map\n");
    expect(discoverInputSourceMap(js)).toBeNull();

    const js2 = join(dir, "remote2.js");
    writeFileSync(js2, "var a=1;\n//# sourceMappingURL=//evil.example.com/app.js.map\n");
    expect(discoverInputSourceMap(js2)).toBeNull();
  });

  it("returns null when there is no adjacent map and no comment", () => {
    const js = join(dir, "none.js");
    writeFileSync(js, "var a=1;\n");
    expect(discoverInputSourceMap(js)).toBeNull();
  });

  it("uses passed-in code without re-reading the file", () => {
    const js = join(dir, "in-memory.js");
    writeFileSync(`${js}.map`, MAP);
    expect(discoverInputSourceMap(js, "var ignored=1;")).toBe(MAP);
  });
});
