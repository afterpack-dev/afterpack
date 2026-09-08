#!/usr/bin/env tsx
/**
 * Strips internal dev scripts from package.json before npm pack/publish.
 * This hides internal build paths from the published package.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface PackageJson {
  scripts?: Record<string, string>;
  [key: string]: unknown;
}

const pkgPath = path.join(__dirname, "..", "package.json");
const backupPath = path.join(__dirname, "..", "package.json.backup");

const pkg: PackageJson = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

// Backup original
fs.writeFileSync(backupPath, `${JSON.stringify(pkg, null, 2)}\n`);

// Remove all scripts from published package (none are useful to consumers)
pkg.scripts = {};

fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log("Stripped dev scripts from package.json for publish");
