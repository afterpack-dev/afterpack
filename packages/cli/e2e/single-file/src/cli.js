#!/usr/bin/env node
// A deliberately SELF-CONTAINED Node CLI: one file, zero imports, no bundler.
// Everything the obfuscator sees for this program is in this single module --
// no cross-file import graph to preserve, which is the whole point of the
// fixture (see ../expectations.json).

const USAGE = "usage: cli.js <sum|describe|--version> [args...]";
const VERSION = "1.4.2";

const HANDLERS = new Map([
  ["sum", sum],
  ["describe", describe],
]);

class Ledger {
  #entries = [];

  add(label, amount) {
    this.#entries.push({ label, amount });
    return this;
  }

  get total() {
    return this.#entries.reduce((n, entry) => n + entry.amount, 0);
  }

  toJSON() {
    return { entries: this.#entries, total: this.total };
  }
}

function sum(args) {
  const ledger = new Ledger();
  for (const [index, raw] of args.entries()) {
    const amount = Number(raw);
    if (!Number.isFinite(amount)) {
      process.stderr.write(`cli: not a number: ${raw}\n`);
      return 1;
    }
    ledger.add(`arg${index}`, amount);
  }
  process.stdout.write(`${JSON.stringify(ledger)}\n`);
  return 0;
}

function describe(args) {
  const [name = "world"] = args;
  process.stdout.write(`${JSON.stringify({ greeting: `hello, ${name}`, argc: args.length })}\n`);
  return 0;
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === "--version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const handler = HANDLERS.get(command);
  if (!handler) {
    process.stderr.write(`cli: unknown command: ${command ?? "(none)"}\n${USAGE}\n`);
    return 1;
  }
  return handler(rest);
}

process.exitCode = main(process.argv.slice(2));
