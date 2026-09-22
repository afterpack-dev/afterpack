import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Fixture } from "./registry.js";

export interface RouteExpectation {
  path: string;
  status: number;
  textContains?: string[];
  selectors?: Record<string, string>;
}

export interface InteractionExpectation {
  route: string;
  description: string;
  click: string;
  expectTextContains?: string[];
}

export interface ApiRouteExpectation {
  path: string;
  status: number;
  jsonEquals?: unknown;
}

export interface SmokeExpectations {
  routes: RouteExpectation[];
  interactions?: InteractionExpectation[];
  apiRoutes?: ApiRouteExpectation[];
  hydration?: { assertNoMismatch?: boolean; note?: string };
  consoleErrors?: string;
}

export interface ObfuscationExpectation {
  minFiles: number;
  passes: number;
}

export interface CliCase {
  description: string;
  args: string[];
  exitCode: number;
  stdout?: string;
  stderrContains?: string[];
}

export interface ElectronExpectations {
  legs: { main: string; preload: string; rendererEntry: string; rendererDir: string };
  bridge: {
    entries: [string, number][];
    expectSummary: { owner: string; total: number; largest: string };
    expectInfo: { channel: string; version: string };
    expectLabel: { input: number; output: string };
    expectThrow: string;
  };
  renderer: { title: string; counterAfterClick: string; bridgeText: string };
}

export interface FixtureExpectations {
  framework: string;
  frameworkClass?: string;
  description?: string;
  seed?: number;
  deterministicOutput?: boolean;
  dualBundle?: boolean;
  build?: { outputDir: string; bundles?: string[]; note?: string };
  obfuscation: ObfuscationExpectation;
  smoke?: SmokeExpectations;
  cli?: { entry: string; cases: CliCase[] };
  electron?: ElectronExpectations;
}

export function readExpectations(target: Fixture | string): FixtureExpectations {
  const dir = typeof target === "string" ? target : target.dir;
  return JSON.parse(readFileSync(join(dir, "expectations.json"), "utf8")) as FixtureExpectations;
}

export function smokeOf(expectations: FixtureExpectations): SmokeExpectations {
  if (!expectations.smoke) {
    throw new Error(`${expectations.framework}: expectations.json declares no smoke block`);
  }
  return expectations.smoke;
}
