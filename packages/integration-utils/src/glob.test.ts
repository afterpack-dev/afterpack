import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { matchesPath, reachesInto } from "./glob.js";

interface VectorCase {
  pattern: string;
  path: string;
  matches: boolean;
}

interface VectorFile {
  sections: { name: string; cases: VectorCase[] }[];
}

const VECTORS_URL = new URL("./glob.vectors.json", import.meta.url);
const vectors = JSON.parse(readFileSync(VECTORS_URL, "utf8")) as VectorFile;

describe("the shared glob vectors", () => {
  it("loaded a corpus rather than an empty file", () => {
    const total = vectors.sections.reduce((n, section) => n + section.cases.length, 0);
    expect(vectors.sections.length).toBeGreaterThan(5);
    expect(total).toBeGreaterThan(40);
  });

  for (const section of vectors.sections) {
    describe(section.name, () => {
      it.each(
        section.cases.map((c) => [c.pattern, c.path, c.matches] as const),
      )("%j vs %j", (pattern, path, matches) => {
        expect(matchesPath(pattern, path)).toBe(matches);
      });
    });
  }
});

describe("reachesInto", () => {
  it("lets the documented node_modules opt-in through", () => {
    expect(reachesInto("**/node_modules/**", "/proj/dist/node_modules")).toBe(true);
  });

  it("is generous for an unanchored pattern, which can match at any depth", () => {
    expect(reachesInto("**/node_modules/left-pad/**", "/proj/node_modules")).toBe(true);
    expect(reachesInto("vendor/**", "/proj/dist/node_modules")).toBe(true);
    expect(matchesPath("vendor/**", "/proj/dist/node_modules/dep/vendor/a.js")).toBe(true);
  });

  it("narrows on an anchored pattern, which can only match one prefix", () => {
    expect(reachesInto("/proj/dist/node_modules/**", "/proj/dist/node_modules")).toBe(true);
    expect(reachesInto("/proj/dist/node_modules/dep/a.js", "/proj/dist/node_modules")).toBe(true);
    expect(reachesInto("/proj/dist/node_modules/**", "/other/node_modules")).toBe(false);
    expect(reachesInto("C:/proj/node_modules/**", "C:\\proj\\node_modules")).toBe(true);
    expect(reachesInto("C:/proj/node_modules/**", "D:\\proj\\node_modules")).toBe(false);
  });

  it("reaches nothing on an empty or separator-only pattern", () => {
    expect(reachesInto("", "/proj/node_modules")).toBe(false);
    expect(reachesInto("///", "/proj/node_modules")).toBe(false);
  });
});
