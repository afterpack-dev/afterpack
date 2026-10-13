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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __reset, __setProcessResult, processBatch } from "../../../test/core-fake.js";
import { backupManifestPath, beginJournal, readBackupManifest } from "../src/backup.js";
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

function invoke(argv: string[]): Promise<number> {
  return run({
    argv,
    cwd: root,
    engine: { processBatch },
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

    const manifest = readBackupManifest(root);
    if (manifest.status !== "ok") throw new Error("expected a backup manifest");
    expect(manifest.manifest.state).toBe("complete");
    expect(manifest.manifest.renames.map((r) => r.from).sort()).toEqual([
      "dist/assets/index-Ab3dE9fG.js",
      "dist/assets/lazy-Q1w2E3r4.js",
    ]);

    expect(await invoke(["restore"])).toBe(0);
    expect(out.join("\n")).toContain("2 renames undone");
    expect(tree()).toEqual(plain);
    expect(existsSync(join(root, ".afterpack", "backup"))).toBe(false);
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
    expect(existsSync(join(root, ".afterpack", "backup"))).toBe(false);
    expect(readdirSync(join(root, ".afterpack", "receipts"))).toEqual([]);
  });

  it("keeps the previous backup when a later run fails partway", async () => {
    viteBuild();
    expect(await invoke(["dist", "--seed=7", ...QUIET])).toBe(0);
    const previous = readFileSync(backupManifestPath(root), "utf8");

    rmSync(dist, { recursive: true, force: true });
    viteBuild();
    mkdirSync(join(dist, "index.html.afterpack-tmp"));
    expect(await invoke(["dist", "--seed=7", ...QUIET])).toBe(1);
    expect(readFileSync(backupManifestPath(root), "utf8")).toBe(previous);
  });
});

describe("afterpack restore after a run that stopped partway", () => {
  function interruptedRun(): Record<string, string> {
    viteBuild();
    const plain = tree();
    const from = join(dist, "assets", "index-Ab3dE9fG.js");
    const to = join(dist, "assets", "index-NeWnAm3s.js");
    beginJournal({
      projectRoot: root,
      protectedRoot: dist,
      cliVersion: "9.9.9",
      touched: [from, to, join(dist, "index.html"), join(dist, "assets", "lazy-Q1w2E3r4.js")],
      renamed: new Map([[from, to]]),
      persist: true,
    });
    writeFileSync(to, "OBF:partial");
    rmSync(from);
    writeFileSync(join(dist, "assets", "lazy-Q1w2E3r4.js"), "OBF:lazy");
    return plain;
  }

  it("puts back the original tree from the copies saved before the first write", async () => {
    const plain = interruptedRun();
    expect(await invoke(["restore"])).toBe(0);
    expect(out.join("\n")).toContain("stopped partway");
    expect(tree()).toEqual(plain);
  });

  it("makes a new run refuse until the interrupted one is restored", async () => {
    interruptedRun();
    expect(await invoke(["dist", "--seed=7", ...QUIET])).toBe(1);
    expect(err.join("\n")).toContain("stopped before it finished");
    expect(err.join("\n")).toContain("afterpack restore");
  });

  it("undoes a write the run had only half finished", async () => {
    const plain = interruptedRun();
    writeFileSync(join(dist, "index.html"), "<script src=");
    rmSync(join(dist, "assets", "index-NeWnAm3s.js"));
    expect(await invoke(["restore"])).toBe(0);
    expect(tree()).toEqual(plain);
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
    write("dist/app/browser/index.html", '<script src="main-ABCD1234.js" type="module"></script>');
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
    expect(Object.values(table).every((hash) => /^[0-9a-f]{40}$/.test(hash))).toBe(true);

    expect(await invoke(["restore"])).toBe(0);
    expect(tree(browser)).toEqual(plain);
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
