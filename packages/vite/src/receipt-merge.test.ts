import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { protectionReceiptPath, verifyProtectionReceipt } from "@afterpack/integration-utils";
import { build, type Plugin } from "vite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __reset, __setProcessResult } from "../../../test/core-fake.js";
import { resetBuildSessions } from "../../integration-utils/src/seed.js";
import { afterpackVite } from "./index.js";

let root: string;
let dist: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "afterpack-vite-merge-")));
  writeFileSync(join(root, "package.json"), "{}");
  dist = join(root, "dist");
  for (const name of ["main", "landing", "admin"]) {
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, "entry.js"), `console.log(${JSON.stringify(name)});\n`);
  }
  resetBuildSessions();
  __reset();
  __setProcessResult((input) => ({
    code: `/*OBF*/${input}`,
    sourceMap: null,
    protectionMap: null,
  }));
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function buildApp(name: string, opts: { afterpack: boolean; emptyOutDir: boolean }) {
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: opts.afterpack ? [afterpackVite({}) as Plugin] : [],
    build: {
      outDir: dist,
      emptyOutDir: opts.emptyOutDir,
      minify: false,
      rollupOptions: {
        input: join(root, name, "entry.js"),
        output: { entryFileNames: `${name}/[name]-[hash].js` },
      },
    },
  });
}

function receiptFiles(): string[] {
  const receipt = JSON.parse(readFileSync(protectionReceiptPath(dist), "utf8"));
  return receipt.files.map((f: { path: string }) => f.path.split("/")[0]);
}

describe("two AfterPack Vite builds into one dist/", () => {
  it("record both builds in one receipt, which verify checks in full", async () => {
    await buildApp("main", { afterpack: true, emptyOutDir: true });
    await buildApp("landing", { afterpack: true, emptyOutDir: false });
    await buildApp("admin", { afterpack: false, emptyOutDir: false });

    expect(receiptFiles()).toEqual(["landing", "main"]);
    expect(verifyProtectionReceipt(protectionReceiptPath(dist), dist).problems).toEqual([]);
  }, 30_000);

  it("forget the earlier build once a later one empties dist/", async () => {
    await buildApp("main", { afterpack: true, emptyOutDir: true });
    await buildApp("landing", { afterpack: true, emptyOutDir: true });

    expect(receiptFiles()).toEqual(["landing"]);
    expect(verifyProtectionReceipt(protectionReceiptPath(dist), dist).problems).toEqual([]);
  }, 30_000);
});
