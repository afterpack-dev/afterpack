import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stagedPath } from "./atomic-write.js";
import {
  afterpackHashSalt,
  cloudEngineMismatch,
  prepareHashSalt,
  type SaltEngine,
  saltSettings,
} from "./hash-salt.js";
import {
  deriveHashToken,
  findHashTokenReference,
  type HashTokenOf,
  planHashedNames,
  unreferencedHashedFiles,
} from "./hashed-names.js";
import { resetBuildSessions } from "./seed.js";

let root: string;

beforeEach(() => {
  resetBuildSessions();
  root = realpathSync(mkdtempSync(join(tmpdir(), "afterpack-hashed-names-")));
});
afterEach(() => {
  resetBuildSessions();
  rmSync(root, { recursive: true, force: true });
});

const DASH_TOKEN: HashTokenOf = (path) => /-([0-9a-f]{16})\.(?:js|css)$/.exec(path)?.[1] ?? null;

function write(rel: string, text: string | Buffer): string {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

describe("deriveHashToken", () => {
  it.each([
    ["0123456789abcdef", /^[0-9a-f]{16}$/],
    ["M4BIKID7", /^[A-Z2-7]{8}$/],
    ["0SSSKEO7TTKZ", /^[0-9A-Z]{12}$/],
    ["0o4l8u3~tr0.~", /^[0-9a-z]{13}$/],
    ["C70DcHUG", /^[0-9A-Za-z]{8}$/],
    ["-cbo_u3q", /^[0-9A-Za-z]{8}$/],
  ])("keeps the length of %s and draws from an alphabet it already uses", (token, shape) => {
    const derived = deriveHashToken(token, "salt");
    expect(derived).toMatch(shape);
    expect(derived).not.toBe(token);
  });

  it("is a function of the token and the salt alone", () => {
    expect(deriveHashToken("0123456789abcdef", "a")).toBe(deriveHashToken("0123456789abcdef", "a"));
    expect(deriveHashToken("0123456789abcdef", "a")).not.toBe(
      deriveHashToken("0123456789abcdef", "b"),
    );
  });
});

describe("planHashedNames", () => {
  it("renames hashed inputs and rewrites every plain-text reference, leaving unrelated text", () => {
    const main = write("static/chunks/main-0123456789abcdef.js", "x");
    const lazy = write("static/chunks/lazy-fedcba9876543210.js", "y");
    const plain = write("static/chunks/plain.js", "z");
    write(
      "build-manifest.json",
      '{"pages":["static/chunks/main-0123456789abcdef.js"],"other":"10123456789abcdef0"}',
    );
    write("server/app/index.html", '<script src="/static/chunks/lazy-fedcba9876543210.js">');
    write("static/media/logo-0123456789abcdef.png", Buffer.from([0, 1, 2, 0x30, 0x31]));
    write("static/chunks/main-0123456789abcdef.js.map", '{"file":"main-0123456789abcdef.js"}');
    write("cache/webpack/pack-0123456789abcdef.txt", "main-0123456789abcdef.js");

    const plan = planHashedNames({
      options: { root, tokenOf: DASH_TOKEN, skip: (rel) => rel === "cache" },
      inputs: new Map([
        [main, { source: 'import("./lazy-fedcba9876543210.js");const m={1:"fedcba9876543210"};' }],
        [lazy, { source: "export const y=1;" }],
        [plain, { source: "export const z=1;" }],
      ]),
      salt: "s",
    });

    const mainToken = deriveHashToken("0123456789abcdef", "s");
    const lazyToken = deriveHashToken("fedcba9876543210", "s");
    expect([...plan.renamed]).toEqual([
      [main, join(root, `static/chunks/main-${mainToken}.js`)],
      [lazy, join(root, `static/chunks/lazy-${lazyToken}.js`)],
    ]);
    expect(
      plan.rewrite('import("./lazy-fedcba9876543210.js");const m={1:"fedcba9876543210"};'),
    ).toBe(`import("./lazy-${lazyToken}.js");const m={1:"${lazyToken}"};`);

    plan.apply();
    expect(readFileSync(join(root, "build-manifest.json"), "utf8")).toBe(
      `{"pages":["static/chunks/main-${mainToken}.js"],"other":"10123456789abcdef0"}`,
    );
    expect(readFileSync(join(root, "server/app/index.html"), "utf8")).toBe(
      `<script src="/static/chunks/lazy-${lazyToken}.js">`,
    );
    expect(readFileSync(join(root, "static/chunks/main-0123456789abcdef.js.map"), "utf8")).toBe(
      '{"file":"main-0123456789abcdef.js"}',
    );
    expect(readFileSync(join(root, "cache/webpack/pack-0123456789abcdef.txt"), "utf8")).toBe(
      "main-0123456789abcdef.js",
    );
    expect(existsSync(join(root, "static/media/logo-0123456789abcdef.png"))).toBe(true);
  });

  it("renames a hashed non-input file whose text changed, and follows references to it", () => {
    const main = write("static/chunks/main-0123456789abcdef.js", "x");
    write("static/chunks/list-1111111111111111.css", "/* main-0123456789abcdef.js */");
    write("static/chunks/runtime.txt", "list-1111111111111111.css");
    write("static/chunks/stable-2222222222222222.css", "a{}");

    const plan = planHashedNames({
      options: { root, tokenOf: DASH_TOKEN },
      inputs: new Map([[main, { source: "x" }]]),
      salt: "s",
    });
    plan.apply();

    const listToken = deriveHashToken("1111111111111111", "s");
    const names = readdirSync(join(root, "static/chunks")).sort();
    expect(names).toContain(`list-${listToken}.css`);
    expect(names).toContain("stable-2222222222222222.css");
    expect(names).not.toContain("list-1111111111111111.css");
    expect(readFileSync(join(root, "static/chunks/runtime.txt"), "utf8")).toBe(
      `list-${listToken}.css`,
    );
    expect(plan.renamed.get(join(root, "static/chunks/list-1111111111111111.css"))).toBe(
      join(root, `static/chunks/list-${listToken}.css`),
    );
  });

  it("changes nothing when no input carries a hash token", () => {
    const plain = write("app.js", "x");
    write("index.html", '<script src="app.js">');
    const plan = planHashedNames({
      options: { root, tokenOf: DASH_TOKEN },
      inputs: new Map([[plain, { source: "x" }]]),
      salt: "s",
    });
    expect(plan.renamed.size).toBe(0);
    expect(plan.rewrite("app.js")).toBe("app.js");
  });

  it("only takes a token the file's own name carries", () => {
    const main = write("static/chunks/main.js", "x");
    const plan = planHashedNames({
      options: { root, tokenOf: () => "0123456789abcdef" },
      inputs: new Map([[main, { source: "x" }]]),
      salt: "s",
    });
    expect(plan.renamed.size).toBe(0);
    expect(basename(main)).toBe("main.js");
  });

  it("gives an input a different name when its directive regions change", () => {
    const main = write("static/chunks/main-0123456789abcdef.js", "x");
    const plan = (regions?: { start: number; end: number }[]) =>
      planHashedNames({
        options: { root, tokenOf: DASH_TOKEN },
        inputs: new Map([[main, { source: "x", regions }]]),
        salt: "s",
      }).renamed.get(main);
    const none = plan();
    expect(plan()).toBe(none);
    expect(plan([{ start: 0, end: 4 }])).not.toBe(none);
    expect(plan([{ start: 0, end: 4 }])).toBe(plan([{ start: 0, end: 4 }]));
    expect(plan([{ start: 0, end: 9 }])).not.toBe(plan([{ start: 0, end: 4 }]));
  });

  it("checks writability up front and never leaves a half-applied tree", () => {
    const main = write("static/chunks/main-0123456789abcdef.js", "x");
    write("static/chunks/manifest.json", "main-0123456789abcdef.js");
    const plan = planHashedNames({
      options: { root, tokenOf: DASH_TOKEN },
      inputs: new Map([[main, { source: "x" }]]),
      salt: "s",
    });
    chmodSync(join(root, "static/chunks"), 0o555);
    try {
      expect(() => plan.preflight()).toThrow(/not writable/);
      expect(() => plan.apply()).toThrow(/not writable/);
    } finally {
      chmodSync(join(root, "static/chunks"), 0o755);
    }
    expect(readFileSync(join(root, "static/chunks/manifest.json"), "utf8")).toBe(
      "main-0123456789abcdef.js",
    );
    expect(existsSync(join(root, "static/chunks/main-0123456789abcdef.js"))).toBe(true);
  });

  it("writes each rewritten reference file through a temp file", () => {
    const main = write("static/chunks/main-0123456789abcdef.js", "x");
    write("manifest.json", "main-0123456789abcdef.js");
    const plan = planHashedNames({
      options: { root, tokenOf: DASH_TOKEN },
      inputs: new Map([[main, { source: "x" }]]),
      salt: "s",
    });
    plan.apply();
    const names = readdirSync(root);
    expect(names.some((name) => name.endsWith(".afterpack-tmp"))).toBe(false);
    expect(readFileSync(join(root, "manifest.json"), "utf8")).toBe(
      `main-${deriveHashToken("0123456789abcdef", "s")}.js`,
    );
  });
});

const LOCAL: SaltEngine = {
  engineVersion: "0.2.4",
  nonce: null,
  cloud: false,
  probedCloudVersion: null,
  probeFailed: false,
};

describe("planHashedNames staging", () => {
  it("lists every reference file it rewrites, renamed or not", () => {
    const main = write("static/chunks/main-0123456789abcdef.js", "x");
    const manifest = write("manifest.json", "main-0123456789abcdef.js");
    const css = write("static/chunks/app-fedcba9876543210.css", "url(main-0123456789abcdef.js)");
    write("unrelated.txt", "nothing to see");
    const plan = planHashedNames({
      options: { root, tokenOf: DASH_TOKEN },
      inputs: new Map([[main, { source: "x" }]]),
      salt: "s",
    });
    const renamedMain = `main-${deriveHashToken("0123456789abcdef", "s")}.js`;
    expect(plan.rewrites).toEqual(
      new Map([
        [manifest, { to: manifest, text: renamedMain }],
        [
          css,
          {
            to: join(root, `static/chunks/app-${deriveHashToken("fedcba9876543210", "s")}.css`),
            text: `url(${renamedMain})`,
          },
        ],
      ]),
    );
  });

  it("stages every rewrite before it replaces any, so a failed stage changes nothing", () => {
    const main = write("static/chunks/main-0123456789abcdef.js", "x");
    write("a.json", "main-0123456789abcdef.js");
    write("b.json", "main-0123456789abcdef.js");
    mkdirSync(stagedPath(join(root, "b.json")));
    const plan = planHashedNames({
      options: { root, tokenOf: DASH_TOKEN },
      inputs: new Map([[main, { source: "x" }]]),
      salt: "s",
    });
    expect(() => plan.apply()).toThrow();
    expect(readFileSync(join(root, "a.json"), "utf8")).toBe("main-0123456789abcdef.js");
    expect(readFileSync(join(root, "b.json"), "utf8")).toBe("main-0123456789abcdef.js");
    expect(existsSync(stagedPath(join(root, "a.json")))).toBe(false);
  });
});

describe("findHashTokenReference", () => {
  const LIMITS = { maxDepth: 4, maxFiles: 100, maxBytes: 1_000_000 };

  it("finds a file outside the root that names a hashed file, and ignores the root itself", () => {
    const main = write("build/client/assets/main-0123456789abcdef.js", "x");
    write("build/client/index.html", "main-0123456789abcdef.js");
    const server = write(
      "build/server/index.js",
      'import "../client/assets/main-0123456789abcdef.js"',
    );
    const options = { root: join(root, "build/client"), tokenOf: DASH_TOKEN };
    expect(findHashTokenReference([join(root, "build")], options, [main], LIMITS)).toEqual({
      found: server,
      truncated: false,
    });
    expect(findHashTokenReference([join(root, "build/client")], options, [main], LIMITS)).toEqual({
      found: null,
      truncated: false,
    });
  });

  it("looks inside server dot-folders, never inside .git or node_modules", () => {
    const main = write("build/assets/main-0123456789abcdef.js", "x");
    const options = { root: join(root, "build"), tokenOf: DASH_TOKEN };
    write(".git/objects/main-0123456789abcdef", "main-0123456789abcdef.js");
    write("node_modules/x/index.js", "main-0123456789abcdef.js");
    expect(
      findHashTokenReference(
        [join(root, ".git"), join(root, "node_modules")],
        options,
        [main],
        LIMITS,
      ),
    ).toEqual({ found: null, truncated: false });
    const server = write(
      ".svelte-kit/output/server/index.js",
      '"/assets/main-0123456789abcdef.js"',
    );
    expect(findHashTokenReference([join(root, ".svelte-kit")], options, [main], LIMITS)).toEqual({
      found: server,
      truncated: false,
    });
  });

  it("reports a scan it had to cut short", () => {
    const main = write("build/client/main-0123456789abcdef.js", "x");
    for (let i = 0; i < 5; i++) write(`build/server/chunk-${i}.js`, "nothing");
    const result = findHashTokenReference(
      [join(root, "build")],
      { root: join(root, "build/client"), tokenOf: DASH_TOKEN },
      [main],
      { ...LIMITS, maxFiles: 3 },
    );
    expect(result).toEqual({ found: null, truncated: true });
  });
});

describe("unreferencedHashedFiles", () => {
  it("names a hashed file that nothing else in the tree refers to", () => {
    const main = write(
      "static/chunks/main-0123456789abcdef.js",
      "import './lazy-1111111111111111.js'",
    );
    const lazy = write("static/chunks/lazy-1111111111111111.js", "x");
    const orphan = write(
      "static/chunks/orphan-2222222222222222.js",
      "//# sourceMappingURL=orphan-2222222222222222.js.map",
    );
    write("index.html", '<script src="/static/chunks/main-0123456789abcdef.js"></script>');
    expect(unreferencedHashedFiles({ root, tokenOf: DASH_TOKEN }, [main, lazy, orphan])).toEqual([
      orphan,
    ]);
  });

  it("is empty when every hashed file is referenced", () => {
    const main = write("static/chunks/main-0123456789abcdef.js", "x");
    write("index.html", "main-0123456789abcdef.js");
    expect(unreferencedHashedFiles({ root, tokenOf: DASH_TOKEN }, [main])).toEqual([]);
  });
});

describe("afterpackHashSalt", () => {
  const base = { seed: 1, engine: LOCAL, settings: { preset: "light" } };

  it("changes with every input that changes the obfuscated bytes", () => {
    const salt = afterpackHashSalt(base);
    expect(afterpackHashSalt({ ...base })).toBe(salt);
    expect(afterpackHashSalt({ ...base, seed: 2 })).not.toBe(salt);
    expect(afterpackHashSalt({ ...base, engine: { ...LOCAL, engineVersion: "0.2.5" } })).not.toBe(
      salt,
    );
    expect(afterpackHashSalt({ ...base, settings: { preset: "hard" } })).not.toBe(salt);
    expect(afterpackHashSalt({ ...base, engine: { ...LOCAL, cloud: true } })).not.toBe(salt);
    expect(afterpackHashSalt({ ...base, engine: { ...LOCAL, nonce: "n" } })).not.toBe(salt);
  });

  it("ignores the order settings were written in", () => {
    expect(afterpackHashSalt({ ...base, settings: { a: 1, b: { c: 2, d: 3 } } })).toBe(
      afterpackHashSalt({ ...base, settings: { b: { d: 3, c: 2 }, a: 1 } }),
    );
  });

  it("leaves out the seed option, diagnostics, git and telemetry from the settings", () => {
    expect(
      saltSettings({
        seed: 5,
        preset: "medium",
        diagnostics: "all",
        artifactOptions: {
          git: false,
          telemetry: { enabled: false },
          sourceMap: { enabled: true },
        },
      }),
    ).toEqual({
      preset: "medium",
      engineConfig: {},
      artifactOptions: { sourceMap: { enabled: true } },
    });
  });
});

function versionFetch(engineVersion: string | null): typeof fetch {
  return (async () => ({
    ok: true,
    json: async () => ({ engineVersion }),
  })) as unknown as typeof fetch;
}

const failFetch = (async () => {
  throw new Error("offline");
}) as unknown as typeof fetch;

describe("prepareHashSalt", () => {
  it("resolves one seed per build and salts with it", async () => {
    const env: Record<string, string | undefined> = {};
    const first = await prepareHashSalt({
      seed: 7,
      root,
      leg: "dist",
      localEngineVersion: "0.2.4",
      settings: {},
      env,
    });
    expect(first.resolvedSeed.seed).toBe(7);
    expect(first.resolvedSeed.origin).toBe("option");
    resetBuildSessions();
    const again = await prepareHashSalt({
      seed: 7,
      root,
      leg: "dist",
      localEngineVersion: "0.2.4",
      settings: {},
      env,
    });
    expect(again.salt).toBe(first.salt);
  });

  it("draws a fresh salt for every unpinned build", async () => {
    const env: Record<string, string | undefined> = {};
    const input = {
      seed: undefined,
      root,
      leg: "dist",
      localEngineVersion: "0.2.4",
      settings: {},
      env,
    };
    const first = await prepareHashSalt(input);
    const second = await prepareHashSalt(input);
    expect(first.resolvedSeed.origin).toBe("fresh");
    expect(second.salt).not.toBe(first.salt);
  });

  it("probes the cloud engine version and folds it into the salt", async () => {
    const at = async (engineVersion: string) =>
      (
        await prepareHashSalt({
          seed: 7,
          root,
          leg: "dist",
          localEngineVersion: "0.2.4",
          settings: {},
          env: { AFTERPACK_KEY: "k" },
          fetchImpl: versionFetch(engineVersion),
        })
      ).salt;
    const local = await prepareHashSalt({
      seed: 7,
      root,
      leg: "dist",
      localEngineVersion: "0.2.4",
      settings: {},
      env: {},
    });
    const cloudA = await at("0.3.0");
    const cloudB = await at("0.4.0");
    expect(cloudA).not.toBe(local.salt);
    expect(cloudB).not.toBe(cloudA);
  });

  it("warns once and draws a fresh nonce when the probe fails", async () => {
    const warnings: string[] = [];
    const input = {
      seed: 7,
      root,
      leg: "dist",
      localEngineVersion: "0.2.4",
      settings: {},
      env: { AFTERPACK_KEY: "k" },
      warn: (message: string) => warnings.push(message),
      fetchImpl: failFetch,
    };
    const first = await prepareHashSalt(input);
    const second = await prepareHashSalt(input);
    expect(first.engine.probeFailed).toBe(true);
    expect(first.engine.nonce).not.toBeNull();
    expect(second.salt).not.toBe(first.salt);
    expect(warnings.filter((message) => message.includes("cloud engine version"))).toHaveLength(2);
  });
});

describe("cloudEngineMismatch", () => {
  const cloud: SaltEngine = {
    engineVersion: "0.3.0",
    nonce: null,
    cloud: true,
    probedCloudVersion: "0.3.0",
    probeFailed: false,
  };

  it("flags a build that ran on a different cloud engine than the probe saw", () => {
    expect(cloudEngineMismatch(cloud, "0.3.1")).toMatch(/0\.3\.0.*0\.3\.1|rerun|re-run/i);
  });

  it("stays silent when the versions match, the probe failed, or the build was local", () => {
    expect(cloudEngineMismatch(cloud, "0.3.0")).toBeNull();
    expect(cloudEngineMismatch({ ...cloud, probedCloudVersion: null }, "0.3.1")).toBeNull();
    expect(cloudEngineMismatch(LOCAL, "0.3.1")).toBeNull();
    expect(cloudEngineMismatch(cloud, null)).toBeNull();
  });
});
