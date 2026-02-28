#!/usr/bin/env node

import { version } from "../package.json";
import { audit } from "./commands/audit.js";

const args = process.argv.slice(2);

// Version flag
if (args.includes("--version") || args.includes("-v")) {
  console.log(`AfterPack v${version}`);
  process.exit(0);
}

// Command routing
const command = args[0];

switch (command) {
  case "audit":
    await audit(args[1]);
    break;

  default:
    console.log(`
  AfterPack v${version}

  ┌─────────────────────────────────────────────────────┐
  │  Launching soon — join the waitlist for day-one     │
  │  access: https://www.afterpack.dev                  │
  └─────────────────────────────────────────────────────┘

  Usage: afterpack <command> [options]

  Commands:
    audit <url>     Audit your frontend for leaked secrets & sensitive data

  Options:
    -v, --version   Show version
`);
    break;
}
