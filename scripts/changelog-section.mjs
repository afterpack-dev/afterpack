import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHANGELOG_FILE, ChangelogError, readSection } from "./lib/changelog.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [version, ...rest] = process.argv.slice(2);
const fileFlag = rest.indexOf("--file");
const file = fileFlag >= 0 ? path.resolve(rest[fileFlag + 1]) : path.join(ROOT, CHANGELOG_FILE);

if (!version || (fileFlag >= 0 && !rest[fileFlag + 1])) {
  console.error("usage: node scripts/changelog-section.mjs <version> [--file <CHANGELOG.md>]");
  process.exit(64);
}

try {
  process.stdout.write(`${readSection(file, version)}\n`);
} catch (error) {
  if (!(error instanceof ChangelogError)) throw error;
  console.error(error.message);
  process.exit(1);
}
