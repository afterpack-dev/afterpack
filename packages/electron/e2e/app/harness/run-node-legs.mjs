import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = dirname(HERE);
const { electron: spec } = JSON.parse(readFileSync(join(FIXTURE, "expectations.json"), "utf8"));

function assertEqual(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: ${a} != ${e}`);
}

const stub = (globalThis.__ELECTRON_STUB__ = {
  windows: [],
  handlers: new Map(),
  exposed: {},
  events: [],
  quit: 0,
});

await import(pathToFileURL(join(FIXTURE, spec.legs.main)).href);
await Promise.resolve();

if (stub.windows.length !== 1) {
  throw new Error(`main leg created ${stub.windows.length} window(s), expected 1`);
}
const [win] = stub.windows;
assertEqual(
  win.loaded,
  { kind: "file", path: resolve(FIXTURE, spec.legs.rendererEntry) },
  "loadFile",
);
assertEqual(
  win.options.webPreferences.preload,
  resolve(FIXTURE, spec.legs.preload),
  "preload path handed to BrowserWindow",
);

const activate = stub.events.find((e) => e.event === "activate");
if (!activate) throw new Error("main leg registered no `activate` handler");
activate.handler();
assertEqual(stub.windows.length, 1, "activate with a window already open");
stub.windows.length = 0;
activate.handler();
assertEqual(stub.windows.length, 1, "activate with no window open");

await import(pathToFileURL(join(FIXTURE, spec.legs.preload)).href);
const bridge = stub.exposed.afterpack;
if (!bridge) throw new Error("preload leg exposed no `afterpack` bridge on the main world");

const summary = await bridge.total(spec.bridge.entries);
assertEqual(
  { owner: summary.owner, total: summary.total, largest: summary.largest },
  spec.bridge.expectSummary,
  "ledger summary over the IPC bridge",
);
assertEqual(summary.entries.length, spec.bridge.entries.length, "ledger entry count");
assertEqual(await bridge.info(), spec.bridge.expectInfo, "app:info over the IPC bridge");
assertEqual(bridge.label(spec.bridge.expectLabel.input), spec.bridge.expectLabel.output, "label()");

let threw = "";
try {
  await bridge.total([["bad", Number.NaN]]);
} catch (error) {
  threw = String(error && error.message);
}
if (!threw.includes(spec.bridge.expectThrow)) {
  throw new Error(
    `expected a rejection containing ${spec.bridge.expectThrow}, got ${threw || "no throw"}`,
  );
}

console.log(`[electron:node-legs] main + preload OK (${stub.handlers.size} ipc handler(s))`);
