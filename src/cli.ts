#!/usr/bin/env node

import { existsSync, statSync } from "node:fs";
import { resolve, relative, extname, basename } from "node:path";

// Import the native addon
// @ts-expect-error - Types will be available after @afterpack/core is published
import { processFile, version } from "@afterpack/core";

const args = process.argv.slice(2);

// Banner
function showBanner(): void {
  console.log(`
  ╔═══════════════════════════════════════════════════════╗
  ║  AfterPack v${version().padEnd(42)}║
  ║  High-performance JavaScript obfuscator               ║
  ╚═══════════════════════════════════════════════════════╝
`);
}

// Help text
function showHelp(): void {
  showBanner();
  console.log(`
Usage:
  npx afterpack <file.js>       Process a JavaScript file
  npx afterpack --version       Show version
  npx afterpack --help          Show this help

Options:
  -h, --help       Show this help message
  -v, --version    Show version number

Examples:
  npx afterpack dist/app.js
  npx afterpack build/index.mjs

Learn more: https://afterpack.dev
`);
}

// Version
if (args.includes("--version") || args.includes("-v")) {
  console.log(`AfterPack v${version()}`);
  process.exit(0);
}

// Help or no args
if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  showHelp();
  process.exit(0);
}

// Filter out flags
const files = args.filter((arg) => !arg.startsWith("-"));

if (files.length === 0) {
  console.error("Error: No file specified");
  console.error("Run 'npx afterpack --help' for usage information");
  process.exit(1);
}

// Process each file
showBanner();

let hasErrors = false;

for (const file of files) {
  const filePath = resolve(file);
  const relativePath = relative(process.cwd(), filePath);

  // Check file exists
  if (!existsSync(filePath)) {
    console.error(`Error: File not found: ${relativePath}`);
    hasErrors = true;
    continue;
  }

  // Check it's a file, not a directory
  if (statSync(filePath).isDirectory()) {
    console.error(`Error: Expected a file, got directory: ${relativePath}`);
    console.error("  Hint: Directory processing coming soon!");
    hasErrors = true;
    continue;
  }

  // Check extension
  const ext = extname(filePath).toLowerCase();
  if (ext !== ".js" && ext !== ".mjs" && ext !== ".cjs") {
    console.error(
      `Error: Expected JavaScript file (.js, .mjs, .cjs), got: ${basename(filePath)}`
    );
    hasErrors = true;
    continue;
  }

  // Process the file
  try {
    console.log(`Processing: ${relativePath}`);
    processFile(filePath);
    console.log(`  Done!`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error processing ${relativePath}: ${message}`);
    hasErrors = true;
  }
}

// Summary
console.log("");
if (hasErrors) {
  console.log("Completed with errors.");
  process.exit(1);
} else {
  console.log("All files processed successfully.");
}
