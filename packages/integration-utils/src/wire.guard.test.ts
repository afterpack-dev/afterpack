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
    {
      sources: [
        join(base, "home", OTHER_USER, "a", "index.ts"),
        join(base, "home", OTHER_USER, "b", "index.ts"),
      ],
    },
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
        sourcesContent: [
          `import("${src}");`,
          `require("${home}/lib.js"); const h = "${home}"; const j = "${home.replaceAll("/", "\\/")}\\/x";`,
        ],
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
    const escapedHome = home.replaceAll("/", "\\/");
    for (const content of [`const h = "${home}";`, `const j = "${escapedHome}\\/x";`]) {
      const map = JSON.stringify({ sources: ["a.ts"], sourcesContent: [content] });
      expect(
        localPathLeaks({ files: [{ path: "x.js", sourceMap: map }], config: {} }, sentinels()),
      ).not.toEqual([]);
    }
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

const CODE_FILE = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/;

function walk(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    if (name === "node_modules" || name === "dist" || name === "e2e") return [];
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return CODE_FILE.test(name) && !name.endsWith(".d.ts") ? [full] : [];
  });
}

function filesOf(pkg: string, tests: boolean): { rel: string; text: string }[] {
  return ["src", "test"]
    .flatMap((dir) => walk(join(PACKAGES, pkg, dir)))
    .filter((file) => file.includes(".test.") === tests)
    .map((file) => ({ rel: file.slice(PACKAGES.length), text: readFileSync(file, "utf8") }));
}

const NETWORK_ALLOWED = new Set([
  "integration-utils/src/telemetry.ts",
  "cli/src/sse.ts",
  "cli/src/audit.ts",
]);

const NETWORK =
  /\bfetch(Impl)?\(|\bundici\b|XMLHttpRequest|\bWebSocket\b|(?:from\s*|require\(\s*|import\(\s*)["'](?:node:)?(?:https?|http2|net|tls|dgram)["']/;

const ENGINE_ENTRIES = ["processBatch", "obfuscate", "obfuscateAll"];

function coreBindings(text: string): { names: string[]; namespaces: string[] } {
  const names: string[] = [];
  const namespaces: string[] = [];
  const core = `["']@afterpack/core["']`;
  for (const m of text.matchAll(new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*${core}`, "g"))) {
    for (const part of m[1].split(",")) {
      const [imported, local] = part
        .replace(/\btype\b/, "")
        .trim()
        .split(/\s+as\s+/);
      if (ENGINE_ENTRIES.includes(imported)) names.push((local ?? imported).trim());
    }
  }
  const destructured = new RegExp(
    `\\{([^}]*)\\}\\s*=\\s*(?:await\\s+)?(?:import|require)\\(\\s*${core}\\s*\\)`,
    "g",
  );
  for (const m of text.matchAll(destructured)) {
    for (const part of m[1].split(",")) {
      const [imported, local] = part.trim().split(/\s*:\s*/);
      if (ENGINE_ENTRIES.includes(imported)) names.push((local ?? imported).trim());
    }
  }
  const namespace = new RegExp(
    `(?:import\\s*\\*\\s*as\\s+(\\w+)\\s+from\\s*${core})|(?:(\\w+)\\s*=\\s*(?:await\\s+)?(?:import|require)\\(\\s*${core}\\s*\\))`,
    "g",
  );
  for (const m of text.matchAll(namespace)) namespaces.push(m[1] ?? m[2]);
  return { names, namespaces };
}

function callsEngine(text: string): string | null {
  if (/\.processBatch\s*\(/.test(text)) return ".processBatch(";
  const { names, namespaces } = coreBindings(text);
  for (const name of names) {
    if (new RegExp(`(?<![\\w.$])${name}\\s*\\(`).test(text)) return `${name}(`;
  }
  for (const ns of namespaces) {
    const call = new RegExp(`\\b${ns}\\s*\\.\\s*(?:${ENGINE_ENTRIES.join("|")})\\s*\\(`);
    if (call.test(text)) return `${ns}.<engine>(`;
  }
  return null;
}

const ENGINE_STUB =
  /\bprocessBatch\s*(?:\([^)]*\)\s*(?::[^{]*)?\{|:\s*(?:async\s*)?(?:\(|function\b|vi\.fn|[A-Za-z_$][\w$]*\s*=>))/;

describe("every front door reaches the cloud only through the path-safe pass", () => {
  const packages = packageDirs();
  const sources = packages.flatMap((pkg) => filesOf(pkg, false));
  const tests = packages.flatMap((pkg) => filesOf(pkg, true));

  it("found the front doors and their tests", () => {
    expect(packages.length).toBeGreaterThanOrEqual(10);
    expect(sources.length).toBeGreaterThanOrEqual(40);
    expect(tests.length).toBeGreaterThanOrEqual(40);
  });

  it.each(
    sources.map((f) => [f.rel, f.text] as const),
  )("%s calls the engine and the network only where paths are made relative", (rel, text) => {
    if (rel !== "integration-utils/src/pass.ts") {
      expect(
        callsEngine(text),
        "calls the engine itself; hand it to runObfuscationPass, which makes every path relative",
      ).toBeNull();
    }
    if (!NETWORK_ALLOWED.has(rel)) {
      expect(text, "opens a network call outside the reviewed senders").not.toMatch(NETWORK);
    }
  });

  it.each(
    tests.map((f) => [f.rel, f.text] as const),
  )("%s puts every engine stub it writes behind the same path check", (_rel, text) => {
    if (!ENGINE_STUB.test(text)) return;
    expect(
      text,
      "defines its own processBatch; wrap the engine in guardedEngine() from test/core-fake.ts",
    ).toContain("guardedEngine(");
  });

  it("recognises an engine call and a stub in the forms a front door could write them", () => {
    const core = '"@afterpack/core"';
    expect(
      callsEngine(`import { processBatch } from ${core};\nprocessBatch(f, c);`),
    ).not.toBeNull();
    expect(callsEngine(`import { obfuscateAll as go } from ${core};\ngo(files);`)).not.toBeNull();
    expect(callsEngine(`const core = await import(${core});\ncore.obfuscate(s);`)).not.toBeNull();
    expect(callsEngine(`const { obfuscate } = require(${core});\nobfuscate(s);`)).not.toBeNull();
    expect(
      callsEngine(`import { processBatch } from ${core};\ngo({ engine: { processBatch } });`),
    ).toBeNull();
    expect(
      callsEngine("class P { async obfuscate(c) {}\n go() { this.obfuscate(1); } }"),
    ).toBeNull();
    for (const sample of [
      'import https from "node:https";',
      'const h = require("http2");',
      'import { connect } from "tls";',
      'const n = await import("net");',
    ]) {
      expect(sample).toMatch(NETWORK);
    }
    expect("const engine = { async processBatch(inputs) { return x; } };").toMatch(ENGINE_STUB);
    expect("const engine = { processBatch: () => Promise.reject(e) };").toMatch(ENGINE_STUB);
    expect("const engine = { processBatch: vi.fn() };").toMatch(ENGINE_STUB);
    expect("go({ engine: { processBatch, version } });").not.toMatch(ENGINE_STUB);
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
    expect(filesOf(pkg, false).some((f) => f.text.includes("runObfuscationPass({"))).toBe(true);
  });
});
