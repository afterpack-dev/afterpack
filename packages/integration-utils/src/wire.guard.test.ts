import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  __reset,
  __setBatchDecorator,
  __setProcessResult,
  localPathLeaks,
  processBatch,
  version,
  wirePayloads,
} from "../../../test/core-fake.js";
import { matchesPath } from "./glob.js";
import type { EngineBatchResult, EngineFileInput, ObfuscationEngine } from "./pass.js";
import { runObfuscationPass } from "./pass.js";
import type { GlobReserved } from "./registry.js";
import { createTelemetryReporter } from "./telemetry.js";

const PACKAGES = fileURLToPath(new URL("../..", import.meta.url));
const REAL_HOME = homedir();
const USER = "zz-sentinel-user";
const OTHER_USER = "zz-other-user";
const silent = { warn: () => {}, log: () => {} };
const engine = { processBatch, version } as unknown as ObfuscationEngine;

const base = mkdtempSync(join(tmpdir(), "afterpack-wire-guard-"));
const home = join(base, "home", USER);
const project = join(home, "work", "app");
const dist = join(project, "dist");
const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

function sentinels(): string[] {
  return [REAL_HOME, home, project, dist, USER, OTHER_USER];
}

function write(path: string, text: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function leaks(): string[] {
  return wirePayloads.flatMap((p) => localPathLeaks(p, sentinels()));
}

function anyMatch(patterns: readonly string[], path: string): boolean {
  return patterns.some((p) => matchesPath(p, path));
}

beforeAll(() => {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(project, "package.json"), '{"name":"app"}');
  writeFileSync(join(project, "package-lock.json"), "{}");
});

afterAll(() => {
  for (const key of ["HOME", "USERPROFILE"] as const) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(base, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(dist, { recursive: true, force: true });
  rmSync(join(project, ".afterpack"), { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  __reset();
  __setProcessResult((input) => ({ code: `OBF:${input}`, sourceMap: null, protectionMap: null }));
});

function buildTree(): { files: string[]; sources: Map<string, string> } {
  const src = join(project, "src", "greet.ts");
  const maps = [
    { sources: [src, join(base, "home", OTHER_USER, "lib", "x.ts")] },
    { sources: [pathToFileURL(src).href] },
    { sourceRoot: `${project}/`, sources: ["src/greet.ts"] },
    {
      sources: [`webpack://${src}`, `webpack://_N_E/ignored|${project}/node_modules/lib|x`],
      file: join(dist, "x.js"),
    },
  ];
  const rels = [
    "static/chunks/x.js",
    "server/chunks/x.js",
    "server/app/static/chunks/x.js",
    "vendor/x.js",
  ];
  const sources = new Map<string, string>();
  const files = rels.map((rel, i) => {
    const file = join(dist, ...rel.split("/"));
    const source = `export const v${i} = ${i};\n//# sourceMappingURL=x.js.map\n`;
    write(file, source);
    write(
      `${file}.map`,
      JSON.stringify({
        version: 3,
        ...maps[i],
        sourcesContent: [`import("${src}");`, `require("${home}/lib.js");`],
        mappings: "AAAA",
      }),
    );
    sources.set(file, source);
    return file;
  });
  return { files, sources };
}

const EXCLUDE = [
  "vendor/**",
  "dist/server/app/**",
  join(dist, "static", "chunks", "x.js"),
  join(home, "nowhere", "*.js"),
];

const RESERVED: (string | GlobReserved)[] = [
  "keepMe",
  { glob: `${USER}/**/server/chunks/*.js`, names: ["serverOnly"] },
];

describe("no path the cloud receives names the machine it came from", () => {
  it("an on-disk build sends paths relative to the build directory and writes each result back to its own file", async () => {
    const { files, sources } = buildTree();
    const observed: { inputs: readonly EngineFileInput[]; batch: EngineBatchResult }[] = [];
    __setBatchDecorator((result) => ({
      ...result,
      source: "cloud",
      files: result.files.map((f) => ({
        ...f,
        diagnostics: [{ severity: "info", code: "DIAG_NOTE", message: "note", file: f.path }],
      })),
    }));

    await runObfuscationPass({
      files,
      engine,
      label: "afterpack-test",
      cwd: project,
      env: {},
      combinedProtectionMap: { buildDir: dist },
      engineConfig: { paths: { exclude: EXCLUDE }, identifiers: { reserved: RESERVED } },
      onBatch: (inputs, batch) => observed.push({ inputs, batch }),
      logger: silent,
    });

    expect(leaks()).toEqual([]);
    const sent = wirePayloads[0];
    expect(sent.files.map((f) => f.path)).toEqual([
      "static/chunks/x.js",
      "server/chunks/x.js",
      "server/app/static/chunks/x.js",
      "vendor/x.js",
    ]);
    for (const file of files) {
      expect(readFileSync(file, "utf8")).toContain(`OBF:${sources.get(file)?.split("\n")[0]}`);
    }
    expect(observed[0].batch.files.map((f) => f.path)).toEqual(files);
    expect(observed[0].batch.files.map((f) => f.diagnostics?.[0]?.file)).toEqual(files);

    const config = sent.config as {
      paths: { exclude: string[] };
      identifiers: { reserved: (string | GlobReserved)[] };
    };
    files.forEach((file, i) => {
      const wirePath = sent.files[i].path;
      expect(anyMatch(config.paths.exclude, wirePath)).toBe(anyMatch(EXCLUDE, file));
      const reservedFor = (list: (string | GlobReserved)[], path: string) =>
        list.flatMap((e) =>
          typeof e === "string" ? [e] : matchesPath(e.glob, path) ? e.names : [],
        );
      expect(reservedFor(config.identifiers.reserved, wirePath)).toEqual(
        reservedFor(RESERVED, file),
      );
    });
  });

  it("an in-memory build labels an input outside the build directory and hands results back by local path", async () => {
    const inside = join(dist, "assets", "x.js");
    const outside = join(home, "elsewhere", "x.js");
    const inputs = new Map([
      [
        inside,
        {
          source: "export const a = 1;",
          sourceMap: JSON.stringify({
            version: 3,
            sources: [join(project, "src", "a.ts")],
            mappings: "",
          }),
        },
      ],
      [outside, { source: "export const b = 2;", sourceMap: null }],
    ]);

    const result = await runObfuscationPass({
      files: [inside, outside],
      inputs,
      emitToCaller: true,
      engine,
      label: "afterpack-test",
      cwd: project,
      env: {},
      combinedProtectionMap: { buildDir: dist },
      logger: silent,
    });

    expect(leaks()).toEqual([]);
    expect(wirePayloads[0].files.map((f) => f.path)).toEqual(["assets/x.js", "_external/0/x.js"]);
    expect(result.outputs?.map((o) => [o.path, o.code])).toEqual([
      [inside, "OBF:export const a = 1;"],
      [outside, "OBF:export const b = 2;"],
    ]);
  });

  it("telemetry from a refused build carries no path, even when the engine's message does", async () => {
    const file = write(join(dist, "static", "x.js"), "export const a = 1;\n");
    const bodies: string[] = [];
    __setProcessResult(() => ({
      code: "",
      diagnostics: [
        {
          severity: "error",
          code: "DIAG_PARSE_ERROR",
          message: `cannot parse ${file} in ${home}`,
          file,
          span: null,
          data: { kind: "parseError", parserErrorKind: "x", path: file },
        },
      ],
    }));
    const telemetry = createTelemetryReporter({
      env: {},
      logger: silent,
      stateFile: join(base, "telemetry.json"),
      fetchImpl: (async (_url: unknown, init?: { body?: unknown }) => {
        bodies.push(String(init?.body));
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });

    await expect(
      runObfuscationPass({
        files: [file],
        engine,
        label: "afterpack-test",
        cwd: project,
        env: {},
        combinedProtectionMap: { buildDir: dist },
        artifactOptions: { telemetry: { enabled: true } },
        telemetry,
        logger: silent,
      }),
    ).rejects.toThrow(/failed to obfuscate/);

    expect(leaks()).toEqual([]);
    expect(bodies).toHaveLength(1);
    for (const sentinel of sentinels()) expect(bodies[0]).not.toContain(sentinel);
  });

  it("the fake cloud endpoint every front door's tests run against refuses a local path", () => {
    expect(
      localPathLeaks({ files: [{ path: join(dist, "x.js") }], config: {} }, sentinels()),
    ).not.toEqual([]);
    expect(
      localPathLeaks(
        {
          files: [{ path: "x.js", sourceMap: JSON.stringify({ sources: [`../${USER}/a.ts`] }) }],
          config: { paths: { exclude: [`${home}/x`] } },
        },
        sentinels(),
      ).length,
    ).toBeGreaterThanOrEqual(2);
  });
});

function packageDirs(): string[] {
  return readdirSync(PACKAGES).filter((pkg) => {
    try {
      return statSync(join(PACKAGES, pkg, "src")).isDirectory();
    } catch {
      return false;
    }
  });
}

function sourceFiles(pkg: string): { rel: string; text: string }[] {
  const src = join(PACKAGES, pkg, "src");
  return readdirSync(src)
    .filter((f) => f.endsWith(".ts") && !f.includes(".test."))
    .map((f) => ({ rel: `${pkg}/src/${f}`, text: readFileSync(join(src, f), "utf8") }));
}

const NETWORK_ALLOWED = new Set([
  "integration-utils/src/telemetry.ts",
  "cli/src/sse.ts",
  "cli/src/audit.ts",
]);

describe("every front door reaches the cloud only through the path-safe pass", () => {
  const packages = packageDirs();

  it("found the front doors", () => {
    expect(packages.length).toBeGreaterThanOrEqual(10);
  });

  it.each(
    packages.flatMap((pkg) => sourceFiles(pkg).map((f) => [f.rel, f.text] as const)),
  )("%s calls the engine and the network only where paths are made relative", (rel, text) => {
    if (rel !== "integration-utils/src/pass.ts") {
      expect(text, "calls processBatch itself; hand the engine to runObfuscationPass").not.toMatch(
        /\.processBatch\(/,
      );
    }
    if (!NETWORK_ALLOWED.has(rel)) {
      expect(text, "opens a network call outside the reviewed senders").not.toMatch(
        /\bfetch(Impl)?\(|node:https?["']|\bundici\b|XMLHttpRequest/,
      );
    }
  });

  it.each(
    packages.filter((pkg) => {
      const manifest = JSON.parse(readFileSync(join(PACKAGES, pkg, "package.json"), "utf8"));
      return ["dependencies", "peerDependencies", "optionalDependencies"].some(
        (field) => manifest[field]?.["@afterpack/core"] !== undefined,
      );
    }),
  )("%s runs its tests against the fake cloud endpoint and builds through the pass", (pkg) => {
    const config = join(PACKAGES, pkg, "vitest.config.ts");
    expect(existsSync(config), `${pkg} has no vitest.config.ts`).toBe(true);
    expect(readFileSync(config, "utf8")).toMatch(/"@afterpack\/core":[\s\S]*?test\/core-fake\.ts/);
    expect(sourceFiles(pkg).some((f) => f.text.includes("runObfuscationPass({"))).toBe(true);
  });
});
