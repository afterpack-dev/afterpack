import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "@playwright/test";
import { PROTECTION_RECEIPT_FILE } from "../../packages/integration-utils/src/receipt.js";
import { readBuildLog } from "./build-log.js";
import { currentFixture } from "./current.js";
import type { Fixture } from "./registry.js";

const PASS_LEVEL = /obfuscating \d+ file\(s\) at (.+?) \.\.\./g;
const REGIONS_SENT = /applied (\d+) directive region\(s\)/g;

export function presetProblems(log: string, preset: string): string[] {
  const levels = [...log.matchAll(PASS_LEVEL)].map((match) => match[1]);
  if (levels.length === 0) return ["the build log shows no obfuscation pass"];
  return levels
    .filter((level) => level !== `preset "${preset}"`)
    .map((level) => `a pass ran at ${level}, not preset "${preset}"`);
}

export function regionsSent(log: string): number {
  return [...log.matchAll(REGIONS_SENT)].reduce((sum, match) => sum + Number(match[1]), 0);
}

export function proBuildProblems(app: Fixture, log: string): string[] {
  const problems: string[] = [];
  for (const dir of app.receipts) {
    const path = join(dir, PROTECTION_RECEIPT_FILE);
    const where = relative(app.dir, path);
    if (!existsSync(path)) {
      problems.push(`no protection receipt at ${where}`);
      continue;
    }
    const { engine } = JSON.parse(readFileSync(path, "utf8")) as { engine: unknown };
    if (engine !== "cloud") problems.push(`${where} says the ${String(engine)} engine ran`);
  }
  if (regionsSent(log) === 0) problems.push("the build sent the engine no directive region");
  return problems;
}

export function candidateLaneTests(): void {
  test.describe("the extra lanes of an engine candidate", () => {
    test(
      "a build at AFTERPACK_preset ran every pass at that preset",
      {
        tag: ["@node", "@lane"],
      },
      () => {
        const preset = process.env.AFTERPACK_preset;
        test.skip(!preset, "only the preset lane sets AFTERPACK_preset");
        expect(presetProblems(readBuildLog(currentFixture()), preset ?? "")).toEqual([]);
      },
    );

    test(
      "a build with AFTERPACK_KEY ran on the cloud engine and sent it the Counter's region",
      {
        tag: ["@node", "@lane"],
      },
      () => {
        test.skip(!process.env.AFTERPACK_KEY, "only the Pro lane sets AFTERPACK_KEY");
        const app = currentFixture();
        expect(proBuildProblems(app, readBuildLog(app))).toEqual([]);
      },
    );

    test("both lane checks reject a keyless build at the default preset", { tag: "@node" }, () => {
      test.skip(
        Boolean(process.env.AFTERPACK_KEY || process.env.AFTERPACK_preset),
        "a lane build is what these checks accept",
      );
      const app = currentFixture();
      const log = readBuildLog(app);
      expect(proBuildProblems(app, log)).toEqual([
        ...app.receipts.map(
          (dir) =>
            `${relative(app.dir, join(dir, PROTECTION_RECEIPT_FILE))} says the local engine ran`,
        ),
        "the build sent the engine no directive region",
      ]);
      expect(presetProblems(log, "extreme")).toContain(
        'a pass ran at preset "light", not preset "extreme"',
      );
    });
  });
}
