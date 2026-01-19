#!/usr/bin/env node

import { version } from "@afterpack/core";

const args = process.argv.slice(2);

// Version flag
if (args.includes("--version") || args.includes("-v")) {
  console.log(`AfterPack v${version()}`);
  process.exit(0);
}

// Audit command
if (args[0] === "audit") {
  console.log(`
  ╔═══════════════════════════════════════════════════════╗
  ║  AfterPack v${version().padEnd(42)}║
  ╚═══════════════════════════════════════════════════════╝

  Audit command coming soon!

  This will analyze your site and reveal what AI can
  extract from your client-side JavaScript.

  ┌─────────────────────────────────────────────────────┐
  │  Join the waitlist to get notified:                 │
  │  https://www.afterpack.dev                          │
  └─────────────────────────────────────────────────────┘
`);
  process.exit(0);
}

// Default: show main waitlist message
console.log(`
  ╔═══════════════════════════════════════════════════════╗
  ║  AfterPack v${version().padEnd(42)}║
  ╚═══════════════════════════════════════════════════════╝

  Coming soon: High-performance JavaScript protection.

  Secure your client-side logic from AI extraction,
  reverse engineering, vulnerability scanning, and
  automated scraping.

  ┌─────────────────────────────────────────────────────┐
  │  Join the waitlist for early access:                │
  │  https://www.afterpack.dev                          │
  └─────────────────────────────────────────────────────┘
`);
