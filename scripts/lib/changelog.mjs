import fs from "node:fs";
import path from "node:path";

export const CHANGELOG_FILE = "CHANGELOG.md";

const TITLE = "# Changelog";
const BYTE_ORDER_MARK = 0xfeff;
const HEADING = /^## (\S+) - (\d{4}-\d{2}-\d{2})\s*$/;

export class ChangelogError extends Error {
  constructor(message) {
    super(message);
    this.name = "ChangelogError";
  }
}

export function releaseVersion(version) {
  const m = /^v?(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    String(version ?? "").trim(),
  );
  if (!m) throw new ChangelogError(`'${version}' is not a version`);
  return m[1];
}

export function sectionOf(text, version) {
  const wanted = releaseVersion(version);
  const unmarked = text.charCodeAt(0) === BYTE_ORDER_MARK ? text.slice(1) : text;
  const lines = unmarked.split(/\r?\n/);
  if (lines[0]?.trim() !== TITLE) {
    throw new ChangelogError(`${CHANGELOG_FILE} does not start with "${TITLE}"`);
  }
  const start = lines.findIndex((line) => HEADING.exec(line)?.[1] === wanted);
  if (start < 0) {
    const loose = lines.find(
      (line) =>
        line.startsWith("## ") &&
        [wanted, `v${wanted}`].includes(line.slice(3).trim().split(/\s+/)[0]),
    );
    throw new ChangelogError(
      loose === undefined
        ? `${CHANGELOG_FILE} has no section for ${wanted}`
        : `${CHANGELOG_FILE} names ${wanted} in "${loose.trim()}", not as "## ${wanted} - YYYY-MM-DD"`,
    );
  }
  const next = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  const body = lines
    .slice(start + 1, next < 0 ? lines.length : next)
    .join("\n")
    .trim();
  if (body === "") throw new ChangelogError(`${CHANGELOG_FILE} has an empty section for ${wanted}`);
  return body;
}

export function readSection(file, version) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw new ChangelogError(`no ${CHANGELOG_FILE} at ${file}`);
    throw error;
  }
  return sectionOf(text, version);
}

export function stageChangelog(root, packageDirs, version) {
  const source = path.join(root, CHANGELOG_FILE);
  readSection(source, version);
  const staged = [];
  try {
    for (const dir of packageDirs) {
      const target = path.join(dir, CHANGELOG_FILE);
      if (fs.existsSync(target)) {
        throw new ChangelogError(
          `${target} already exists, likely left by an interrupted pack: remove it (rm ${target}); the root ${CHANGELOG_FILE} is the only one`,
        );
      }
      fs.copyFileSync(source, target);
      staged.push(target);
    }
  } catch (error) {
    for (const file of staged) fs.rmSync(file, { force: true });
    throw error;
  }
  return () => {
    for (const file of staged) fs.rmSync(file, { force: true });
  };
}
