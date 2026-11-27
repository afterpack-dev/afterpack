import { join, parse } from "node:path";
import { describe, expect, it } from "vitest";
import { pathBundleLabel, qualifiedBundleLabel, sanitizeBundleLabel } from "./bundle-label.js";

const root = join(parse(process.cwd()).root, "work", "app");

describe("pathBundleLabel", () => {
  it("is the path relative to the root, with forward slashes", () => {
    expect(pathBundleLabel(join(root, "vite.landing.config.ts"), root)).toBe(
      "vite.landing.config.ts",
    );
    expect(pathBundleLabel(join(root, "configs", "vite.config.ts"), root)).toBe(
      "configs/vite.config.ts",
    );
  });

  it("is only the basename outside the root, never an absolute path", () => {
    const outside = join(root, "..", "shared", "vite.config.ts");
    expect(pathBundleLabel(outside, root)).toBe("vite.config.ts");
    expect(pathBundleLabel(join(root, ".."), root)).toBe("work");
  });

  it("is the root's own name when the path is the root", () => {
    expect(pathBundleLabel(root, root)).toBe("app");
  });

  it("keeps a sibling whose name only starts with two dots inside the root", () => {
    expect(pathBundleLabel(join(root, "..dist"), root)).toBe("..dist");
  });
});

describe("qualifiedBundleLabel", () => {
  it("appends the qualifier in parentheses", () => {
    expect(qualifiedBundleLabel("vite.config.ts", "ssr")).toBe("vite.config.ts (ssr)");
    expect(qualifiedBundleLabel("astro", "client")).toBe("astro (client)");
    expect(qualifiedBundleLabel("vite.config.ts", undefined)).toBe("vite.config.ts");
    expect(qualifiedBundleLabel(undefined, "ssr")).toBeUndefined();
  });
});

describe("sanitizeBundleLabel", () => {
  it("keeps printable text of at most 120 characters, trimmed", () => {
    expect(sanitizeBundleLabel("  vite.config.ts (ssr) ")).toBe("vite.config.ts (ssr)");
    expect(sanitizeBundleLabel("x".repeat(120))).toHaveLength(120);
    expect(sanitizeBundleLabel("приложение/vite.config.ts")).toBe("приложение/vite.config.ts");
  });

  it("counts characters, not UTF-16 units, as the engine and server do", () => {
    expect(sanitizeBundleLabel("\u{1F680}".repeat(120))).toBe("\u{1F680}".repeat(120));
    expect(sanitizeBundleLabel("\u{1F680}".repeat(121))).toBeNull();
  });

  it("drops anything else", () => {
    for (const value of [
      "x".repeat(121),
      "",
      "   ",
      "a\nb",
      "a\u0000b",
      "a‮b",
      "a\u001b[31mb",
      undefined,
      null,
      7,
    ]) {
      expect(sanitizeBundleLabel(value)).toBeNull();
    }
  });
});
