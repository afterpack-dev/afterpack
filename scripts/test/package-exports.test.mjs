import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const published = fs
  .readdirSync(path.join(ROOT, "packages"))
  .map((name) => path.join(ROOT, "packages", name))
  .filter((dir) => fs.existsSync(path.join(dir, "package.json")))
  .map((dir) => ({ dir, pkg: JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) }))
  .filter(({ pkg }) => pkg.private !== true);

const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "package-exports-")));
for (const { dir, pkg } of published) {
  const link = path.join(project, "node_modules", ...pkg.name.split("/"));
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(dir, link, "dir");
}
fs.writeFileSync(path.join(project, "package.json"), "{}");

after(() => fs.rmSync(project, { recursive: true, force: true }));

describe("every published package", () => {
  it("is found", () => {
    assert.ok(published.length > 10);
  });

  for (const { dir, pkg } of published) {
    const manifest = path.join(fs.realpathSync(dir), "package.json");

    it(`${pkg.name} hands out its package.json to require`, () => {
      const resolved = createRequire(path.join(project, "index.cjs")).resolve(
        `${pkg.name}/package.json`,
      );
      assert.equal(fs.realpathSync(resolved), manifest);
    });

    it(`${pkg.name} hands out its package.json to import`, () => {
      const resolved = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `console.log(import.meta.resolve(${JSON.stringify(`${pkg.name}/package.json`)}))`,
        ],
        { cwd: project, encoding: "utf8" },
      ).trim();
      assert.equal(fs.realpathSync(fileURLToPath(resolved)), manifest);
    });
  }
});
