import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { expectObfuscationPass, readBuildLog } from "@e2e/helpers/build-log.js";
import { readExpectations } from "@e2e/helpers/expectations.js";
import { fixture } from "@e2e/helpers/registry.js";
import { expectObfuscationSignatures } from "@e2e/helpers/signatures.js";

const app = fixture("cli-single-file");
const expectations = readExpectations(app);
const cli = expectations.cli;
if (!cli) throw new Error("the single-file fixture needs a `cli` block in expectations.json");

test.describe("the CLI obfuscates a directory holding exactly one file", { tag: "@quick" }, () => {
  test("the build ran a real obfuscation pass over the shipped files", { tag: "@node" }, () => {
    expectObfuscationPass(readBuildLog(app), app.name, expectations.obfuscation);
  });

  test(
    "the shipped file carries obfuscation signatures, not mere minification",
    { tag: "@node" },
    () => {
      expectObfuscationSignatures(app);
    },
  );

  test("the shipped directory holds exactly one JavaScript file", { tag: "@node" }, () => {
    const js = readdirSync(join(app.dir, "dist")).filter((name) => /\.(js|mjs|cjs)$/.test(name));
    expect(js).toHaveLength(1);
  });

  for (const testCase of cli.cases) {
    test(testCase.description, { tag: "@node" }, () => {
      const result = spawnSync(process.execPath, [join(app.dir, cli.entry), ...testCase.args], {
        encoding: "utf8",
      });
      expect(result.error).toBeUndefined();
      expect(result.status, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(
        testCase.exitCode,
      );
      if (testCase.stdout !== undefined) expect(result.stdout).toBe(testCase.stdout);
      for (const needle of testCase.stderrContains ?? []) {
        expect(result.stderr).toContain(needle);
      }
    });
  }
});

test.describe("the CLI's own protection receipt gates a deploy", { tag: "@quick" }, () => {
  const afterpackCli = createRequire(join(app.dir, "package.json")).resolve("afterpack");
  const dist = join(app.dir, "dist");
  const obfuscateArgs = ["dist", `--seed=${expectations.seed}`, "--build.backup=false"];

  function afterpack(args: string[]) {
    return spawnSync(process.execPath, [afterpackCli, ...args], {
      cwd: app.dir,
      encoding: "utf8",
    });
  }

  test(
    "verify passes the built tree, a re-run over it is refused, a rebuilt tree passes again",
    { tag: "@node" },
    () => {
      const verified = afterpack(["verify", "dist"]);
      expect(verified.status, `stderr: ${verified.stderr}`).toBe(0);
      expect(verified.stdout).toContain("Verified 1 file");

      const reRun = afterpack(obfuscateArgs);
      expect(reRun.status, `stdout: ${reRun.stdout}`).toBe(1);
      expect(reRun.stderr).toContain("Already obfuscated");

      cpSync(join(app.dir, "src", "cli.js"), join(dist, "cli.js"));
      chmodSync(join(dist, "cli.js"), 0o755);
      const rebuilt = afterpack(obfuscateArgs);
      expect(rebuilt.status, `stderr: ${rebuilt.stderr}`).toBe(0);

      const reVerified = afterpack(["verify", "dist"]);
      expect(reVerified.status, `stderr: ${reVerified.stderr}`).toBe(0);
    },
  );
});
