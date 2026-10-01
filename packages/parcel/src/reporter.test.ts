import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  PROTECTION_RECEIPT_FILE,
  type ProtectionReceipt,
  verifyProtectionReceipt,
} from "@afterpack/integration-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BundleRecord, writeBundleRecord } from "./records.js";
import receiptReporter from "./reporter.js";

const PLUGIN_CONFIG = Symbol.for("parcel-plugin-config");

interface ReportArgs {
  event: unknown;
  options: unknown;
  logger: unknown;
}

const handlers = (receiptReporter as unknown as Record<symbol, { report(a: ReportArgs): void }>)[
  PLUGIN_CONFIG
];

let root: string;
let dist: string;
let warnings: string[];
let infos: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "afterpack-parcel-reporter-test-"));
  dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  warnings = [];
  infos = [];
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function record(overrides: Partial<BundleRecord> = {}): BundleRecord {
  return {
    tool: "afterpack-parcel",
    engine: "local",
    engineVersion: "0.2.1",
    seed: "7",
    seedOrigin: "config",
    transformed: true,
    ...overrides,
  };
}

interface FakeBundle {
  id: string;
  type?: string;
  shouldOptimize?: boolean;
  bundleBehavior?: string | null;
  distDir?: string;
  file: string;
  content?: string;
}

function bundle(b: FakeBundle): unknown {
  const dir = b.distDir ?? dist;
  const filePath = join(dir, b.file);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, b.content ?? `obfuscated ${b.id}`);
  return {
    id: b.id,
    type: b.type ?? "js",
    bundleBehavior: b.bundleBehavior ?? null,
    env: { shouldOptimize: b.shouldOptimize ?? true },
    target: { distDir: dir },
    filePath,
  };
}

function report(bundles: unknown[], type = "buildSuccess"): void {
  handlers.report({
    event: { type, bundleGraph: { getBundles: () => bundles } },
    options: { projectRoot: root },
    logger: {
      warn: ({ message }: { message: string }) => warnings.push(message),
      info: ({ message }: { message: string }) => infos.push(message),
    },
  });
}

function receiptIn(dir: string): ProtectionReceipt {
  return JSON.parse(readFileSync(join(dir, PROTECTION_RECEIPT_FILE), "utf8"));
}

describe("the Parcel receipt reporter", () => {
  it("writes the receipt over the files Parcel wrote, which afterpack verify then passes", () => {
    writeBundleRecord(root, "app", record());
    writeBundleRecord(root, "lazy", record({ transformed: false }));

    report([
      bundle({ id: "app", file: "app.05f9e6d8.js" }),
      bundle({ id: "lazy", file: "lazy/counter.62303d69.js" }),
      bundle({ id: "page", type: "html", file: "index.html" }),
    ]);

    expect(receiptIn(dist)).toMatchObject({
      tool: "afterpack-parcel",
      engine: "local",
      engineVersion: "0.2.1",
      seed: "7",
      seedOrigin: "config",
      bundler: "parcel",
      buildId: null,
      files: [
        { path: "app.05f9e6d8.js", transformed: true },
        { path: "lazy/counter.62303d69.js", transformed: false },
      ],
    });
    expect(verifyProtectionReceipt(dist).problems).toEqual([]);
    expect(infos.join("\n")).toContain("wrote protection receipt");
  });

  it("fails a later verify once a shipped file changes", () => {
    writeBundleRecord(root, "app", record());
    report([bundle({ id: "app", file: "app.js" })]);

    writeFileSync(join(dist, "app.js"), "tampered");

    expect(verifyProtectionReceipt(dist).problems).toEqual([
      "app.js: content changed since it was obfuscated",
    ]);
  });

  it("writes one receipt per target directory", () => {
    const legacy = join(root, "dist-legacy");
    writeBundleRecord(root, "modern", record({ seed: "1" }));
    writeBundleRecord(root, "legacy", record({ seed: "2" }));

    report([
      bundle({ id: "modern", file: "app.js" }),
      bundle({ id: "legacy", file: "app.js", distDir: legacy }),
    ]);

    expect(receiptIn(dist).seed).toBe("1");
    expect(receiptIn(legacy).seed).toBe("2");
  });

  it("names every seed when the workers drew different ones", () => {
    writeBundleRecord(root, "a", record({ seed: "1", seedOrigin: "session" }));
    writeBundleRecord(root, "b", record({ seed: "2", seedOrigin: "session" }));

    report([bundle({ id: "a", file: "a.js" }), bundle({ id: "b", file: "b.js" })]);

    expect(receiptIn(dist)).toMatchObject({ seed: "1,2", seedOrigin: "session" });
  });

  it("writes no receipt, and removes an old one, when a shipped bundle has no record", () => {
    writeFileSync(join(dist, PROTECTION_RECEIPT_FILE), "{}");
    writeBundleRecord(root, "app", record());

    report([bundle({ id: "app", file: "app.js" }), bundle({ id: "cached", file: "chunk.js" })]);

    expect(existsSync(join(dist, PROTECTION_RECEIPT_FILE))).toBe(false);
    expect(warnings.join("\n")).toContain("no record of obfuscating dist/chunk.js");
  });

  it("ignores what the optimizer never sees: other types, inline scripts, unoptimized builds", () => {
    report([
      bundle({ id: "css", type: "css", file: "app.css" }),
      bundle({ id: "inline", bundleBehavior: "inline", file: "inline.js" }),
      bundle({ id: "dev", shouldOptimize: false, file: "dev.js" }),
    ]);

    expect(existsSync(join(dist, PROTECTION_RECEIPT_FILE))).toBe(false);
    expect(warnings).toEqual([]);
  });

  it("trusts only the records this build wrote: buildStart forgets the last build's", () => {
    writeBundleRecord(root, "app", record());

    report([], "buildStart");
    report([bundle({ id: "app", file: "app.js", content: "cleartext" })]);

    expect(existsSync(join(dist, PROTECTION_RECEIPT_FILE))).toBe(false);
    expect(warnings.join("\n")).toContain("no record of obfuscating dist/app.js");
  });

  it("acts only on a successful build", () => {
    writeBundleRecord(root, "app", record());

    report([bundle({ id: "app", file: "app.js" })], "buildFailure");

    expect(existsSync(join(dist, PROTECTION_RECEIPT_FILE))).toBe(false);
  });
});
