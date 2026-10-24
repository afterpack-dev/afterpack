import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ChangelogError,
  readSection,
  releaseVersion,
  sectionOf,
  stageChangelog,
} from "../lib/changelog.mjs";

const SCRIPT = path.join(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  "changelog-section.mjs",
);

const CHANGELOG = [
  "# Changelog",
  "",
  "The full changelog, cloud and dashboard included, is at https://www.afterpack.dev/changelog.",
  "",
  "## 1.0.1 - 2026-10-24",
  "",
  "- verify counts the JS files its receipt does not list.",
  "",
  "### Fixes",
  "",
  "- Two builds into one directory share one receipt.",
  "",
  "## 1.0.0 - 2026-10-23",
  "",
  "First stable release.",
  "",
].join("\n");

const scratch = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "changelog-test-"));
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("releaseVersion", () => {
  it("maps a prerelease or build to its base version", () => {
    assert.equal(releaseVersion("1.0.1-rc.20261024"), "1.0.1");
    assert.equal(releaseVersion("v1.0.1"), "1.0.1");
    assert.equal(releaseVersion("1.0.1+build.5"), "1.0.1");
    assert.equal(releaseVersion("1.0.1"), "1.0.1");
  });

  it("refuses what is not a version", () => {
    assert.throws(() => releaseVersion("1.0"), ChangelogError);
    assert.throws(() => releaseVersion(""), ChangelogError);
  });
});

describe("sectionOf", () => {
  it("returns a release's body up to the next release heading, keeping its subsections", () => {
    assert.equal(
      sectionOf(CHANGELOG, "1.0.1"),
      [
        "- verify counts the JS files its receipt does not list.",
        "",
        "### Fixes",
        "",
        "- Two builds into one directory share one receipt.",
      ].join("\n"),
    );
  });

  it("returns the last release's body up to the end of the file", () => {
    assert.equal(sectionOf(CHANGELOG, "1.0.0"), "First stable release.");
  });

  it("finds a release candidate's section by its base version", () => {
    assert.equal(sectionOf(CHANGELOG, "1.0.0-rc.20261020"), "First stable release.");
  });

  it("reads a file with CRLF line ends and a byte-order mark", () => {
    assert.equal(
      sectionOf(`${String.fromCharCode(0xfeff)}${CHANGELOG.replace(/\n/g, "\r\n")}`, "1.0.0"),
      "First stable release.",
    );
  });

  it("fails on a version it has no section for", () => {
    assert.throws(() => sectionOf(CHANGELOG, "1.0.2"), /has no section for 1\.0\.2/);
  });

  it("never matches a version that only starts the same", () => {
    const text = CHANGELOG.replace("## 1.0.1 - 2026-10-24", "## 1.0.10 - 2026-10-24");
    assert.throws(() => sectionOf(text, "1.0.1"), /has no section for 1\.0\.1/);
  });

  it("names a heading that lacks the date", () => {
    const text = CHANGELOG.replace("## 1.0.1 - 2026-10-24", "## 1.0.1");
    assert.throws(() => sectionOf(text, "1.0.1"), /not as "## 1\.0\.1 - YYYY-MM-DD"/);
  });

  it("fails on an empty section", () => {
    const text = "# Changelog\n\n## 1.0.2 - 2026-10-25\n\n## 1.0.1 - 2026-10-24\n\nx\n";
    assert.throws(() => sectionOf(text, "1.0.2"), /empty section for 1\.0\.2/);
  });

  it("fails on a file that is not the generated changelog", () => {
    assert.throws(
      () => sectionOf("# Notes\n\n## 1.0.0 - 2026-10-23\n\nx\n", "1.0.0"),
      /does not start/,
    );
  });
});

describe("readSection", () => {
  it("fails clearly when there is no CHANGELOG.md", () => {
    const file = path.join(tempDir(), "CHANGELOG.md");
    assert.throws(() => readSection(file, "1.0.0"), /no CHANGELOG\.md at/);
  });
});

describe("changelog-section.mjs", () => {
  function run(args) {
    return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  }

  it("prints the section of the version it is given", () => {
    const file = path.join(tempDir(), "CHANGELOG.md");
    fs.writeFileSync(file, CHANGELOG);
    const result = run(["1.0.0-rc.1", "--file", file]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "First stable release.\n");
  });

  it("exits 1 with the reason when the section is missing", () => {
    const file = path.join(tempDir(), "CHANGELOG.md");
    fs.writeFileSync(file, CHANGELOG);
    const result = run(["9.9.9", "--file", file]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /has no section for 9\.9\.9/);
  });

  it("exits 1 when the file is missing", () => {
    const result = run(["1.0.0", "--file", path.join(tempDir(), "CHANGELOG.md")]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no CHANGELOG\.md at/);
  });

  it("exits 64 without a version", () => {
    assert.equal(run([]).status, 64);
  });
});

describe("stageChangelog", () => {
  function workspace() {
    const root = tempDir();
    const dirs = ["a", "b"].map((name) => path.join(root, "packages", name));
    for (const dir of dirs) fs.mkdirSync(dir, { recursive: true });
    return { root, dirs };
  }

  it("copies the root changelog into every package and removes the copies after", () => {
    const { root, dirs } = workspace();
    fs.writeFileSync(path.join(root, "CHANGELOG.md"), CHANGELOG);
    const cleanup = stageChangelog(root, dirs, "1.0.1");
    for (const dir of dirs) {
      assert.equal(fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf8"), CHANGELOG);
    }
    cleanup();
    for (const dir of dirs) assert.equal(fs.existsSync(path.join(dir, "CHANGELOG.md")), false);
  });

  it("refuses to pack a version the changelog has no section for, copying nothing", () => {
    const { root, dirs } = workspace();
    fs.writeFileSync(path.join(root, "CHANGELOG.md"), CHANGELOG);
    assert.throws(() => stageChangelog(root, dirs, "1.0.2"), /has no section for 1\.0\.2/);
    for (const dir of dirs) assert.equal(fs.existsSync(path.join(dir, "CHANGELOG.md")), false);
  });

  it("refuses without a root changelog", () => {
    const { root, dirs } = workspace();
    assert.throws(() => stageChangelog(root, dirs, "1.0.1"), /no CHANGELOG\.md at/);
  });

  it("never overwrites a package's own changelog, and undoes the copies it made", () => {
    const { root, dirs } = workspace();
    fs.writeFileSync(path.join(root, "CHANGELOG.md"), CHANGELOG);
    fs.writeFileSync(path.join(dirs[1], "CHANGELOG.md"), "own");
    assert.throws(() => stageChangelog(root, dirs, "1.0.1"), /already exists/);
    assert.equal(fs.existsSync(path.join(dirs[0], "CHANGELOG.md")), false);
    assert.equal(fs.readFileSync(path.join(dirs[1], "CHANGELOG.md"), "utf8"), "own");
  });
});
