import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stagedPath, writeFileAtomic } from "./atomic-write.js";
import { stripCssSourceMappingURLs } from "./source-map.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "afterpack-atomic-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  it("replaces the file whole and keeps its mode", () => {
    const file = join(root, "cli.js");
    writeFileSync(file, "old");
    chmodSync(file, 0o755);
    writeFileAtomic(file, "new");
    expect(readFileSync(file, "utf8")).toBe("new");
    expect(statSync(file).mode & 0o777).toBe(0o755);
    expect(existsSync(stagedPath(file))).toBe(false);
  });

  it("leaves the original untouched when the staged write fails", () => {
    const file = join(root, "app.js");
    writeFileSync(file, "old");
    mkdirSync(stagedPath(file));
    expect(() => writeFileAtomic(file, "new")).toThrow();
    expect(readFileSync(file, "utf8")).toBe("old");
  });
});

describe("stripCssSourceMappingURLs", () => {
  it("writes through a staged file, so a failed write never truncates the stylesheet", () => {
    const css = join(root, "site.css");
    const text = "body{}\n/*# sourceMappingURL=site.css.map */";
    writeFileSync(css, text);
    mkdirSync(stagedPath(css));
    expect(() => stripCssSourceMappingURLs([css])).toThrow();
    expect(readFileSync(css, "utf8")).toBe(text);
  });
});
