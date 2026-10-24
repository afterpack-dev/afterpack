import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { protectionReceiptPath, writeProtectionReceipt } from "@afterpack/integration-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __reset, __setProcessResult, processBatch } from "../../../test/core-fake.js";
import { run } from "../src/run.js";

let root: string;

const quiet = { log: () => {}, error: () => {}, warn: () => {} };

function write(rel: string, content: string): string {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "afterpack-receipt-rollback-")));
  writeFileSync(join(root, "package.json"), "{}");
  __reset();
  __setProcessResult((input) => ({ code: `OBF:${input}`, sourceMap: null, protectionMap: null }));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("a run that fails after writing the receipt", () => {
  it("puts back the receipt that was there before it", async () => {
    write("dist/app/browser/index.html", '<script src="main-ABCD1234.js" type="module"></script>');
    write("dist/app/browser/main-ABCD1234.js", "export const a = 1;");
    write("dist/app/browser/ngsw.json", JSON.stringify({ hashTable: { "/gone.js": "x" } }));
    const browser = join(root, "dist", "app", "browser");
    const earlier = write("dist/app/browser/earlier.txt", "earlier");
    writeProtectionReceipt({
      dir: browser,
      tool: "afterpack",
      engine: "local",
      engineVersion: null,
      seed: 1,
      seedOrigin: "fresh",
      bundler: "unknown",
      buildId: null,
      files: [earlier],
      transformed: [earlier],
    });
    const receipt = protectionReceiptPath(browser);
    const before = readFileSync(receipt, "utf8");

    const code = await run({
      argv: ["dist/app/browser", "--protectionMap.enabled=false"],
      cwd: root,
      engine: { processBatch },
      logger: quiet,
      version: "9.9.9",
      env: {},
    });

    expect(code).not.toBe(0);
    expect(readFileSync(join(browser, "main-ABCD1234.js"), "utf8")).toBe("export const a = 1;");
    expect(readFileSync(receipt, "utf8")).toBe(before);
  });
});
