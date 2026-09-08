#!/usr/bin/env tsx
/**
 * Restores original package.json after npm pack/publish.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const pkgPath = path.join(__dirname, "..", "package.json");
const backupPath = path.join(__dirname, "..", "package.json.backup");

if (fs.existsSync(backupPath)) {
  fs.copyFileSync(backupPath, pkgPath);
  fs.unlinkSync(backupPath);
  console.log("Restored original package.json");
} else {
  console.log("No backup found, skipping restore");
}
