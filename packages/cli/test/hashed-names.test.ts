import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import type { ObfuscationEngine } from "@afterpack/integration-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __reset,
  __setProcessResult,
  guardedEngine,
  processBatch,
} from "../../../test/core-fake.js";
import { backupSlot, beginJournal, readBackupManifest } from "../src/backup.js";
import { KEPT_NAMES_NOTICE } from "../src/layout.js";
import { run } from "../src/run.js";

let root: string;
let dist: string;
let out: string[];
let err: string[];
let warnings: string[];

const logger = {
  log: (m: string) => out.push(m),
  error: (m: string) => err.push(m),
  warn: (m: string) => warnings.push(m),
};

function invoke(argv: string[], engine: ObfuscationEngine = { processBatch }): Promise<number> {
  return run({
    argv,
    cwd: root,
    engine,
    logger,
    version: "9.9.9",
    env: {},
    stdout: { isTTY: false, write: () => {} },
  });
}

const QUIET = ["--protectionMap.enabled=false", "--telemetry.enabled=false"];

function write(rel: string, text: string): string {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function tree(dir = dist): Record<string, string> {
  const outTree: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else outTree[relative(dir, full).split(sep).join("/")] = readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return outTree;
}

function viteBuild(): void {
  write("package.json", "{}");
  write(
    "dist/index.html",
    '<script type="module" src="/assets/index-Ab3dE9fG.js"></script>' +
      '<link rel="stylesheet" href="/assets/index-Zz9yX8wV.css">',
  );
  write("dist/assets/index-Ab3dE9fG.js", 'import("./lazy-Q1w2E3r4.js");');
  write("dist/assets/lazy-Q1w2E3r4.js", "export const lazy = 1;");
  write("dist/assets/index-Zz9yX8wV.css", "body{}");
  write(
    "dist/.vite/manifest.json",
    JSON.stringify({
      "index.html": { file: "assets/index-Ab3dE9fG.js", css: ["assets/index-Zz9yX8wV.css"] },
      "src/lazy.js": { file: "assets/lazy-Q1w2E3r4.js" },
    }),
  );
  write("dist/favicon.svg", "<svg/>");
}

function jsNames(): string[] {
  return readdirSync(join(dist, "assets"))
    .filter((name) => name.endsWith(".js"))
    .sort();
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "afterpack-cli-hashed-")));
  dist = join(root, "dist");
  out = [];
  err = [];
  warnings = [];
  __reset();
  __setProcessResult((input) => ({ code: `OBF:${input}`, sourceMap: null, protectionMap: null }));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("afterpack on a Vite build", () => {
  it("renames every obfuscated chunk and points the HTML, the manifest and the chunks at it", async () => {
    viteBuild();
    expect(await invoke(["dist", "--seed=7", ...QUIET])).toBe(0);

    const [index, lazy] = [
      jsNames().find((name) => name.startsWith("index-")) as string,
      jsNames().find((name) => name.startsWith("lazy-")) as string,
    ];
    expect(index).toMatch(/^index-[A-Za-z0-9]{8}\.js$/);
    expect(index).not.toBe("index-Ab3dE9fG.js");
    expect(lazy).not.toBe("lazy-Q1w2E3r4.js");
    expect(jsNames()).toEqual([index, lazy].sort());

    const files = tree();
    expect(files[`assets/${index}`]).toBe(`OBF:import("./${lazy}");`);
    expect(files["index.html"]).toContain(`/assets/${index}`);
    expect(files["index.html"]).toContain("/assets/index-Zz9yX8wV.css");
    expect(files[".vite/manifest.json"]).toContain(`assets/${lazy}`);
    expect(files[".vite/manifest.json"]).not.toContain("Ab3dE9fG");
    expect(warnings.join("\n")).not.toContain(KEPT_NAMES_NOTICE);
  });

  it("gives the same build the same names under one seed, and new names under another", async () => {
    viteBuild();
    expect(await invoke(["dist", "--seed=7", ...QUIET, "--build.backup=false"])).toBe(0);
    const first = tree();
    rmSync(join(root, ".afterpack"), { recursive: true, force: true });
    rmSync(dist, { recursive: true, force: true });
    viteBuild();
    expect(await invoke(["dist", "--seed=7", ...QUIET, "--build.backup=false"])).toBe(0);
    expect(tree()).toEqual(first);

    const firstNames = jsNames();
    rmSync(join(root, ".afterpack"), { recursive: true, force: true });
    rmSync(dist, { recursive: true, force: true });
    viteBuild();
    expect(await invoke(["dist", "--seed=8", ...QUIET, "--build.backup=false"])).toBe(0);
    expect(jsNames().filter((name) => firstNames.includes(name))).toEqual([]);
  });

  it("restores the original tree byte for byte, undoing every rename", async () => {
    viteBuild();
    const plain = tree();
    expect(await invoke(["dist", "--seed=7", ...QUIET])).toBe(0);
    expect(tree()).not.toEqual(plain);

    const manifest = readBackupManifest(backupSlot(root, "dist"));
    if (manifest.status !== "ok") throw new Error("expected a backup manifest");
    expect(manifest.manifest.state).toBe("complete");
    expect(manifest.manifest.renames.map((r) => r.from).sort()).toEqual([
      "dist/assets/index-Ab3dE9fG.js",
      "dist/assets/lazy-Q1w2E3r4.js",
    ]);

    expect(await invoke(["restore"])).toBe(0);
    expect(out.join("\n")).toContain("2 renames undone");
    expect(tree()).toEqual(plain);
    expect(existsSync(backupSlot(root, "dist").container)).toBe(false);
  });

  it("verifies the renamed tree and a deploy copy of it", async () => {
    viteBuild();
    expect(await invoke(["dist", "--seed=7", ...QUIET])).toBe(0);
    expect(await invoke(["verify", "dist"])).toBe(0);
    expect(out.join("\n")).toContain("Verified 2 files");

    cpSync(dist, join(root, "deploy", "public"), { recursive: true });
    out = [];
    expect(await invoke(["verify", "deploy"])).toBe(0);
    expect(out.join("\n")).toContain("copy of dist/");
  });

  it("refuses a second run over the renamed tree", async () => {
    viteBuild();
    expect(await invoke(["dist", "--seed=7", ...QUIET])).toBe(0);
    expect(await invoke(["dist", "--seed=7", ...QUIET])).toBe(1);
    expect(err.join("\n")).toContain("Already obfuscated");
  });

  it("leaves the original tree when a write fails partway through", async () => {
    viteBuild();
    const blocker = join(dist, "index.html.afterpack-tmp");
    mkdirSync(blocker);
    const plain = tree();

    expect(await invoke(["dist", "--seed=7", ...QUIET])).toBe(1);
    expect(err.join("\n")).toContain("left exactly as your bundler wrote it");
    expect(tree()).toEqual(plain);
    expect(statSync(blocker).isDirectory()).toBe(true);
    expect(existsSync(backupSlot(root, "dist").current)).toBe(false);
    expect(readdirSync(join(root, ".afterpack", "receipts"))).toEqual([]);
  });

  it("keeps the previous backup when a later run fails partway", async () => {
    viteBuild();
    expect(await invoke(["dist", "--seed=7", ...QUIET])).toBe(0);
    const previous = readFileSync(backupSlot(root, "dist").manifestPath, "utf8");

    rmSync(dist, { recursive: true, force: true });
    viteBuild();
    mkdirSync(join(dist, "index.html.afterpack-tmp"));
    expect(await invoke(["dist", "--seed=7", ...QUIET])).toBe(1);
    expect(readFileSync(backupSlot(root, "dist").manifestPath, "utf8")).toBe(previous);
  });
});

describe("afterpack restore after a run that stopped partway", () => {
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const slot = () => backupSlot(root, "dist");

  function interruptedRun(): Record<string, string> {
    viteBuild();
    const plain = tree();
    const from = join(dist, "assets", "index-Ab3dE9fG.js");
    const to = join(dist, "assets", "index-NeWnAm3s.js");
    const lazy = join(dist, "assets", "lazy-Q1w2E3r4.js");
    beginJournal({
      slot: slot(),
      protectedRoot: dist,
      cliVersion: "9.9.9",
      planned: new Map<string, (string | null)[]>([
        [from, [null]],
        [to, [sha("OBF:index")]],
        [`${to}.afterpack-tmp`, [null]],
        [join(dist, "index.html"), [sha("<script src=/assets/index-NeWnAm3s.js>")]],
        [lazy, [sha("OBF:lazy")]],
      ]),
      renamed: new Map([[from, to]]),
      persist: true,
    });
    writeFileSync(to, "OBF:index");
    rmSync(from);
    writeFileSync(lazy, "OBF:lazy");
    writeFileSync(`${to}.afterpack-tmp`, "OBF:ind");
    return plain;
  }

  it("puts back the original tree from the copies saved before the first write", async () => {
    const plain = interruptedRun();
    expect(await invoke(["restore"])).toBe(0);
    expect(out.join("\n")).toContain("stopped partway");
    expect(tree()).toEqual(plain);
  });

  it("makes a new run refuse until the interrupted one is restored, and names the ways out", async () => {
    interruptedRun();
    expect(await invoke(["dist", "--seed=7", ...QUIET])).toBe(1);
    const text = err.join("\n");
    expect(text).toContain("stopped before it finished");
    expect(text).toContain("afterpack restore");
    expect(text).toContain("rebuild the output from source");
    expect(text).toContain(".afterpack/backups/dist");
  });

  it("refuses, touching nothing, when the output was rebuilt after the run stopped", async () => {
    interruptedRun();
    rmSync(dist, { recursive: true, force: true });
    viteBuild();
    writeFileSync(join(dist, "assets", "lazy-Q1w2E3r4.js"), "export const lazy = 2;");
    const rebuilt = tree();

    expect(await invoke(["restore"])).toBe(1);
    expect(err.join("\n")).toContain("changed since an afterpack run stopped partway");
    expect(tree()).toEqual(rebuilt);
    expect(existsSync(slot().manifestPath)).toBe(true);
  });

  it("discards the stale backup on the next run over a rebuilt output, saying so once", async () => {
    interruptedRun();
    rmSync(dist, { recursive: true, force: true });
    viteBuild();
    writeFileSync(join(dist, "assets", "lazy-Q1w2E3r4.js"), "export const lazy = 2;");

    expect(await invoke(["dist", "--seed=7", ...QUIET])).toBe(0);
    expect(warnings.filter((w) => w.includes("Discarded the backup"))).toHaveLength(1);
    const manifest = readBackupManifest(slot());
    expect(manifest.status === "ok" && manifest.manifest.state).toBe("complete");
  });

  it("discards it too when a rebuild gave back the very same bytes", async () => {
    interruptedRun();
    rmSync(dist, { recursive: true, force: true });
    viteBuild();
    expect(await invoke(["dist", "--seed=7", ...QUIET])).toBe(0);
    expect(warnings.join("\n")).toContain("already matches what your bundler wrote");
  });

  it("names the way out when the backup lost a copy, and lets a rebuild clear it", async () => {
    interruptedRun();
    rmSync(join(slot().current, "files", "dist", "assets", "lazy-Q1w2E3r4.js"));

    expect(await invoke(["restore"])).toBe(1);
    const text = err.join("\n");
    expect(text).toContain("The backup is missing the original");
    expect(text).toContain("Rebuild the output from source");
    expect(text).toContain(".afterpack/backups/dist");

    rmSync(dist, { recursive: true, force: true });
    viteBuild();
    expect(await invoke(["dist", "--seed=7", ...QUIET])).toBe(0);
  });
});

describe("afterpack restore that stopped partway itself", () => {
  it("finishes on a second restore", async () => {
    viteBuild();
    const plain = tree();
    expect(await invoke(["dist", "--seed=7", ...QUIET])).toBe(0);
    const manifest = readBackupManifest(backupSlot(root, "dist"));
    if (manifest.status !== "ok") throw new Error("expected a backup manifest");
    const first = manifest.manifest.files.find((f) => f.originalSha256 !== null) as {
      path: string;
    };
    cpSync(
      join(backupSlot(root, "dist").current, "files", ...first.path.split("/")),
      join(root, ...first.path.split("/")),
    );

    expect(await invoke(["restore"])).toBe(0);
    expect(tree()).toEqual(plain);
  });
});

describe("two afterpack runs at once", () => {
  function gatedEngine(): {
    engine: ObfuscationEngine;
    release: () => void;
    started: Promise<void>;
  } {
    let release = () => {};
    let started = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    return {
      engine: guardedEngine({
        processBatch: async (...args: Parameters<typeof processBatch>) => {
          started();
          await gate;
          return processBatch(...args);
        },
      }),
      release,
      started: startedPromise,
    };
  }

  it("refuses the second run over the same directory while the first holds the lock", async () => {
    viteBuild();
    const plain = tree();
    const gated = gatedEngine();
    const first = invoke(["dist", "--seed=7", ...QUIET], gated.engine);
    await gated.started;

    expect(await invoke(["dist", "--seed=7", ...QUIET])).toBe(1);
    expect(err.join("\n")).toContain("Another afterpack run");
    expect(err.join("\n")).toContain(".afterpack/backups/dist/lock");
    expect(tree()).toEqual(plain);

    gated.release();
    expect(await first).toBe(0);
    expect(existsSync(backupSlot(root, "dist").lockPath)).toBe(false);
    expect(await invoke(["restore", "dist"])).toBe(0);
    expect(tree()).toEqual(plain);
  });

  it("lets runs over different directories of one project go side by side", async () => {
    viteBuild();
    write("web/index.html", '<script type="module" src="/assets/web-Wb1cD2eF.js"></script>');
    write("web/assets/web-Wb1cD2eF.js", "export const web = 1;");
    const plainDist = tree();
    const plainWeb = tree(join(root, "web"));
    const gated = gatedEngine();
    const first = invoke(["dist", "--seed=7", ...QUIET], gated.engine);
    await gated.started;

    expect(await invoke(["web", "--seed=7", ...QUIET])).toBe(0);
    gated.release();
    expect(await first).toBe(0);

    expect(await invoke(["restore"])).toBe(0);
    expect(tree()).toEqual(plainDist);
    expect(tree(join(root, "web"))).toEqual(plainWeb);
  });

  it("takes over a lock whose process is gone, with a notice", async () => {
    viteBuild();
    mkdirSync(backupSlot(root, "dist").container, { recursive: true });
    writeFileSync(
      backupSlot(root, "dist").lockPath,
      JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: new Date().toISOString(), token: "x" }),
    );
    expect(await invoke(["dist", "--seed=7", ...QUIET])).toBe(0);
    expect(warnings.join("\n")).toContain("Took over a lock left by process");
  });
});

describe("afterpack on a Next.js build", () => {
  it("renames the client chunks and rewrites the server manifests that name them", async () => {
    write("package.json", "{}");
    write(".next/BUILD_ID", "fixture");
    mkdirSync(join(root, ".next", "turbopack"), { recursive: true });
    write(".next/static/chunks/0ghe5rzlpm1le.js", 'import("./0tjd6zdagvqu6.js")');
    write(".next/static/chunks/0tjd6zdagvqu6.js", "export const lazy = 1;");
    write(".next/build-manifest.json", '{"pages":{"/":["static/chunks/0ghe5rzlpm1le.js"]}}');
    write(".next/server/app/index.html", '<script src="/_next/static/chunks/0ghe5rzlpm1le.js">');
    const plain = tree(join(root, ".next"));

    expect(await invoke([".next/static/chunks", "--seed=7", ...QUIET])).toBe(0);
    const chunks = readdirSync(join(root, ".next", "static", "chunks")).sort();
    expect(chunks).not.toContain("0ghe5rzlpm1le.js");
    expect(chunks).not.toContain("0tjd6zdagvqu6.js");
    const chunkText = (name: string) =>
      readFileSync(join(root, ".next", "static", "chunks", name), "utf8");
    const main = chunks.find((name) => chunkText(name).startsWith("OBF:import(")) as string;
    const lazy = chunks.find((name) => name !== main) as string;
    expect(chunkText(main)).toBe(`OBF:import("./${lazy}")`);
    expect(readFileSync(join(root, ".next", "build-manifest.json"), "utf8")).toContain(
      `static/chunks/${main}`,
    );
    expect(readFileSync(join(root, ".next", "server", "app", "index.html"), "utf8")).toContain(
      `/_next/static/chunks/${main}`,
    );

    expect(await invoke(["restore"])).toBe(0);
    expect(tree(join(root, ".next"))).toEqual(plain);
  });
});

describe("afterpack on an Angular build", () => {
  it("renames the browser chunks, recomputes the service worker table, and restores", async () => {
    write("package.json", "{}");
    write(
      "dist/app/browser/index.html",
      '<script src="main-ABCD1234.js" type="module" integrity="sha384-stale"></script>',
    );
    write("dist/app/browser/main-ABCD1234.js", 'import"./chunk-EFGH5678.js";');
    write("dist/app/browser/chunk-EFGH5678.js", "export const a = 1;");
    write(
      "dist/app/browser/ngsw.json",
      JSON.stringify({ hashTable: { "/main-ABCD1234.js": "0", "/chunk-EFGH5678.js": "0" } }),
    );
    const browser = join(root, "dist", "app", "browser");
    const plain = tree(browser);

    expect(await invoke(["dist/app/browser", "--seed=7", ...QUIET])).toBe(0);
    const names = readdirSync(browser).filter((name) => name.endsWith(".js"));
    expect(names).toHaveLength(2);
    expect(names).not.toContain("main-ABCD1234.js");
    const table = (
      JSON.parse(readFileSync(join(browser, "ngsw.json"), "utf8")) as {
        hashTable: Record<string, string>;
      }
    ).hashTable;
    expect(Object.keys(table).sort()).toEqual(names.map((name) => `/${name}`).sort());
    const final = (name: string) => readFileSync(join(browser, name));
    for (const name of names) {
      expect(table[`/${name}`]).toBe(createHash("sha1").update(final(name)).digest("hex"));
    }
    const main = names.find((name) => name.startsWith("main-")) as string;
    const html = readFileSync(join(browser, "index.html"), "utf8");
    expect(html).toContain(`src="${main}"`);
    expect(html).toContain(
      `integrity="sha384-${createHash("sha384").update(final(main)).digest("base64")}"`,
    );

    expect(await invoke(["restore"])).toBe(0);
    expect(tree(browser)).toEqual(plain);
  });
});

describe("afterpack beside a backup an earlier afterpack left", () => {
  it("replaces it once its own backup of the same directory is complete", async () => {
    viteBuild();
    const legacy = join(root, ".afterpack", "backup");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(
      join(legacy, "manifest.json"),
      JSON.stringify({
        schema: 1,
        protectedRoot: dist,
        files: [],
        timestamp: "t",
        cliVersion: "0.2.0",
        receiptPath: null,
      }),
    );
    expect(await invoke(["dist", "--seed=7", ...QUIET])).toBe(0);
    expect(existsSync(legacy)).toBe(false);
  });
});

describe("afterpack on a Vite SSR client build", () => {
  it("keeps the names a server bundle beside it hard-codes, and says why", async () => {
    write("package.json", "{}");
    write(
      "build/client/index.html",
      '<script type="module" src="/assets/entry-Ab3dE9fG.js"></script>',
    );
    write("build/client/assets/entry-Ab3dE9fG.js", "export const a = 1;");
    write("build/server/index.js", 'export const entry = "/assets/entry-Ab3dE9fG.js";');
    expect(await invoke(["build/client", "--seed=7", ...QUIET])).toBe(0);
    expect(existsSync(join(root, "build", "client", "assets", "entry-Ab3dE9fG.js"))).toBe(true);
    expect(warnings.join("\n")).toContain(
      `build/server/index.js names files in build/client, so renaming them would break it. ${KEPT_NAMES_NOTICE}`,
    );
  });
});

describe("afterpack on output it cannot rename", () => {
  it("keeps hashed names and says so once", async () => {
    write("package.json", "{}");
    write("dist/_app/immutable/entry.DdA1bC2e.js", "export const a = 1;");
    expect(await invoke(["dist", "--seed=7", ...QUIET])).toBe(0);
    expect(existsSync(join(dist, "_app", "immutable", "entry.DdA1bC2e.js"))).toBe(true);
    expect(warnings.filter((w) => w.includes(KEPT_NAMES_NOTICE))).toHaveLength(1);
  });

  it("prints no notice for output with no hashed names", async () => {
    write("package.json", "{}");
    write("dist/app.js", "export const a = 1;");
    expect(await invoke(["dist", "--seed=7", ...QUIET])).toBe(0);
    expect(warnings.join("\n")).not.toContain(KEPT_NAMES_NOTICE);
  });
});
