import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect } from "@playwright/test";
import { runBuild, withFixtureDirLock } from "./build.js";
import { readExpectations } from "./expectations.js";
import { expectVerifyPasses } from "./receipt.js";
import { type Fixture, REPO_ROOT } from "./registry.js";

const CLI = join(REPO_ROOT, "packages", "cli", "dist", "cli.js");
const DEPLOY_COPY = "deploy-copy";

function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "cache") walk(full);
        continue;
      }
      if (entry.name.startsWith("trace")) continue;
      out.set(
        relative(dir, full).split(sep).join("/"),
        createHash("sha256").update(readFileSync(full)).digest("hex"),
      );
    }
  };
  walk(dir);
  return out;
}

function afterpack(fixture: Fixture, args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: fixture.dir,
    encoding: "utf8",
    env: { ...process.env, ...fixture.env, AFTERPACK_telemetry_enabled: "false" },
  });
  const output = `${result.stdout}${result.stderr}`;
  expect(result.status, `${fixture.name}: afterpack ${args.join(" ")}\n${output}`).toBe(0);
  return output;
}

export function expectRestoreUndoesRenames(
  fixture: Fixture,
  cliTarget: string,
  treeDir: string = cliTarget,
): void {
  const seed = String(readExpectations(fixture).seed);
  const log = (step: string) => `${fixture.buildLog}.restore-${step}`;
  const tree = join(fixture.dir, treeDir);
  withFixtureDirLock(fixture.dir, () => {
    try {
      runBuild(fixture, { AFTERPACK_build_autorun: "false" }, log("plain"));
      const plain = snapshot(tree);

      expect(afterpack(fixture, [cliTarget, `--seed=${seed}`])).toContain("renamed");
      const protectedTree = snapshot(tree);
      expect(
        [...plain.keys()].filter((name) => !protectedTree.has(name)).length,
        `${fixture.name}: the CLI run renamed no content-hashed file`,
      ).toBeGreaterThan(0);

      expectVerifyPasses(fixture, cliTarget);
      cpSync(join(fixture.dir, cliTarget), join(fixture.dir, DEPLOY_COPY, cliTarget), {
        recursive: true,
      });
      expectVerifyPasses(fixture, DEPLOY_COPY);

      expect(afterpack(fixture, ["restore"])).toContain("renames undone");
      expect(
        snapshot(tree),
        `${fixture.name}: afterpack restore did not give back the plain build byte for byte`,
      ).toEqual(plain);
    } finally {
      rmSync(join(fixture.dir, DEPLOY_COPY), { recursive: true, force: true });
      runBuild(fixture, {}, log("rebuild"));
    }
  });
}

const KILL_HOOK = join(REPO_ROOT, "e2e", "helpers", "kill-after-writes.cjs");

export function expectKilledRunRestores(
  fixture: Fixture,
  cliTarget: string,
  treeDir: string = cliTarget,
  kill: { writes?: number; removes?: number } = { writes: 2 },
): void {
  const seed = String(readExpectations(fixture).seed);
  const point = kill.removes ? `remove-${kill.removes}` : `write-${kill.writes ?? 0}`;
  const log = (step: string) => `${fixture.buildLog}.kill-${point}-${step}`;
  const tree = join(fixture.dir, treeDir);
  withFixtureDirLock(fixture.dir, () => {
    try {
      runBuild(fixture, { AFTERPACK_build_autorun: "false" }, log("plain"));
      const plain = snapshot(tree);

      const killed = spawnSync(
        process.execPath,
        ["--require", KILL_HOOK, CLI, cliTarget, `--seed=${seed}`],
        {
          cwd: fixture.dir,
          encoding: "utf8",
          env: {
            ...process.env,
            ...fixture.env,
            AFTERPACK_telemetry_enabled: "false",
            AFTERPACK_E2E_KILL_AFTER_WRITES: String(kill.writes ?? 0),
            AFTERPACK_E2E_KILL_AFTER_REMOVES: String(kill.removes ?? 0),
            AFTERPACK_E2E_KILL_UNDER: realpathSync(tree),
          },
        },
      );
      expect(killed.signal, `${fixture.name}: ${killed.stdout}${killed.stderr}`).toBe("SIGKILL");
      expect(snapshot(tree), `${fixture.name}: the killed run wrote nothing`).not.toEqual(plain);

      expect(afterpack(fixture, ["restore"])).toContain("stopped partway");
      expect(
        snapshot(tree),
        `${fixture.name}: afterpack restore did not undo the killed run byte for byte`,
      ).toEqual(plain);
    } finally {
      runBuild(fixture, {}, log("rebuild"));
    }
  });
}
