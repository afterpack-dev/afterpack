#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { processBatch, version } from "@afterpack/core";
import { resolveClientIdentity } from "@afterpack/integration-utils";
import { CONTACT_FOOTER } from "./args.js";
import { dim } from "./format.js";
import { defaultCliStdout, run } from "./run.js";

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

run({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  engine: { processBatch, version },
  logger: console,
  version: readVersion(),
  stdout: defaultCliStdout(),
  client: resolveClientIdentity(import.meta.url),
})
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`afterpack: ${error instanceof Error ? error.message : String(error)}`);
    console.error(dim(CONTACT_FOOTER));
    process.exitCode = 1;
  });
