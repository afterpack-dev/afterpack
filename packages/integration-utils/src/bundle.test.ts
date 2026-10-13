import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  type BundleEntryLike,
  type OutputBundleLike,
  regenerateCompressedSiblings,
  sourceTypeForBundle,
  sriPluginRefusal,
  stripBundleCssSourceMaps,
} from "./bundle.js";

describe("stripBundleCssSourceMaps", () => {
  it("deletes every CSS map and the trailer that points at it, and nothing else", () => {
    const bundle: OutputBundleLike = {
      "assets/index.css": {
        type: "asset",
        fileName: "assets/index.css",
        source: "a{color:red}\n/*# sourceMappingURL=index.css.map */\n",
      },
      "assets/index.css.map": { type: "asset", fileName: "assets/index.css.map", source: "{}" },
      "assets/theme.css": {
        type: "asset",
        fileName: "assets/theme.css",
        source: new TextEncoder().encode("b{}\n/*# sourceMappingURL=theme.css.map*/"),
      },
      "assets/theme.css.map": { type: "asset", fileName: "assets/theme.css.map", source: "{}" },
      "assets/index.js": { type: "chunk", fileName: "assets/index.js", code: "x()" },
      "assets/index.js.map": { type: "asset", fileName: "assets/index.js.map", source: "{}" },
      "assets/plain.css": { type: "asset", fileName: "assets/plain.css", source: "c{}\n" },
    };

    stripBundleCssSourceMaps(bundle);

    expect(Object.keys(bundle).sort()).toEqual([
      "assets/index.css",
      "assets/index.js",
      "assets/index.js.map",
      "assets/plain.css",
      "assets/theme.css",
    ]);
    expect(bundle["assets/index.css"].source).toBe("a{color:red}\n");
    expect(bundle["assets/theme.css"].source).toBe("b{}\n");
    expect(bundle["assets/plain.css"].source).toBe("c{}\n");
    expect(bundle["assets/index.js"].code).toBe("x()");
  });
});

describe("sourceTypeForBundle", () => {
  const chunk: BundleEntryLike = { type: "chunk", fileName: "a.js", code: "" };
  const asset: BundleEntryLike = { type: "asset", fileName: "w.js", source: "" };

  it("is module for ES output made only of chunks", () => {
    expect(sourceTypeForBundle("es", [chunk, chunk])).toBe("module");
  });

  it("is unset when any entry is an asset, whatever the format", () => {
    expect(sourceTypeForBundle("es", [chunk, asset])).toBeUndefined();
  });

  it("is unset for a non-module format", () => {
    expect(sourceTypeForBundle("system", [chunk])).toBeUndefined();
    expect(sourceTypeForBundle("iife", [chunk])).toBeUndefined();
    expect(sourceTypeForBundle(undefined, [chunk])).toBeUndefined();
  });
});

describe("regenerateCompressedSiblings", () => {
  it("rebuilds a .gz sibling of an obfuscated chunk from the obfuscated bytes", () => {
    const bundle: OutputBundleLike = {
      "index.js": { type: "chunk", fileName: "index.js", code: "OBF" },
      "index.js.gz": { type: "asset", fileName: "index.js.gz", source: Buffer.from("stale") },
      "vendor.js.gz": { type: "asset", fileName: "vendor.js.gz", source: Buffer.from("left") },
    };
    regenerateCompressedSiblings(bundle, new Set(["index.js"]), "test");
    expect(gunzipSync(bundle["index.js.gz"].source as Uint8Array).toString()).toBe("OBF");
    expect(Buffer.from(bundle["vendor.js.gz"].source as Uint8Array).toString()).toBe("left");
  });

  it("fails on a compressed sibling it cannot regenerate", () => {
    const bundle: OutputBundleLike = {
      "index.js": { type: "chunk", fileName: "index.js", code: "OBF" },
      "index.js.zst": { type: "asset", fileName: "index.js.zst", source: Buffer.from("x") },
    };
    expect(() => regenerateCompressedSiblings(bundle, new Set(["index.js"]), "test")).toThrow(
      /zst/,
    );
  });
});

describe("sriPluginRefusal", () => {
  it("names an SRI plugin and stays silent otherwise", () => {
    expect(sriPluginRefusal([{ name: "vite-plugin-sri" }], "afterpack-vite")).toMatch(/integrity/i);
    expect(sriPluginRefusal([{ name: "@foo/subresource-integrity" }], "x")).not.toBeNull();
    expect(sriPluginRefusal([{ name: "vite-plugin-react" }, { name: "legacy" }], "x")).toBeNull();
    expect(sriPluginRefusal(undefined, "x")).toBeNull();
  });
});
