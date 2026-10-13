import { createHash } from "node:crypto";
import {
  copyFileSync,
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
import { dirname, join, relative, sep } from "node:path";
import type { ObfuscationEngine } from "@afterpack/integration-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __reset,
  __setProcessResult,
  guardedEngine,
  processBatch,
} from "../../../test/core-fake.js";
import { addScratch, backupSlot, beginJournal, readBackupManifest } from "../src/backup.js";
import { run } from "../src/run.js";

let root: string;
let out: string[];
let err: string[];
let warnings: string[];

const logger = {
  log: (m: string) => out.push(m),
  error: (m: string) => err.push(m),
  warn: (m: string) => warnings.push(m),
};

const QUIET = ["--protectionMap.enabled=false", "--telemetry.enabled=false", "--seed=7"];
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

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

function write(rel: string, text: string): string {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

function tree(rel: string): Record<string, string> {
  const dir = join(root, rel);
  const files: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[relative(dir, full).split(sep).join("/")] = readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return files;
}

function viteBuild(dir = "dist"): void {
  write(`${dir}/index.html`, '<script type="module" src="/assets/index-Ab3dE9fG.js"></script>');
  write(`${dir}/assets/index-Ab3dE9fG.js`, 'import("./lazy-Q1w2E3r4.js");');
  write(`${dir}/assets/lazy-Q1w2E3r4.js`, "export const lazy = 1;");
}

function gatedEngine(): { engine: ObfuscationEngine; release: () => void; started: Promise<void> } {
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

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "afterpack-journal-safety-")));
  write("package.json", "{}");
  out = [];
  err = [];
  warnings = [];
  __reset();
  __setProcessResult((input) => ({ code: `OBF:${input}`, sourceMap: null, protectionMap: null }));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("a finished file run, then a killed one in the same directory", () => {
  async function finishA(): Promise<void> {
    write("dist/a.js", "export const a = 1;");
    write("dist/b.js", "export const b = 2;");
    write("dist/c.js", "export const c = 3;");
    expect(await invoke(["dist/a.js", ...QUIET])).toBe(0);
    expect(read("dist/a.js")).toContain("OBF:");
  }

  function killB(writeIt: boolean): void {
    const b = join(root, "dist", "b.js");
    beginJournal({
      slot: backupSlot(root, "dist"),
      protectedRoot: join(root, "dist"),
      cliVersion: "9.9.9",
      planned: new Map([[b, [sha("OBF:b")]]]),
      renamed: new Map(),
      persist: true,
      merge: true,
    });
    if (writeIt) writeFileSync(b, "OBF:b");
  }

  it("keeps a.js's original when b.js's run was killed after writing", async () => {
    await finishA();
    killB(true);

    expect(await invoke(["dist/c.js", ...QUIET])).toBe(1);
    expect(err.join("\n")).toContain("stopped before it finished");

    expect(await invoke(["restore"])).toBe(0);
    expect(read("dist/a.js")).toBe("export const a = 1;");
    expect(read("dist/b.js")).toBe("export const b = 2;");
  });

  it("keeps a.js's original when b.js's run was killed before writing anything", async () => {
    await finishA();
    killB(false);

    expect(await invoke(["dist/c.js", ...QUIET])).toBe(0);
    expect(warnings.join("\n")).toContain("Discarded the backup");
    expect(await invoke(["restore"])).toBe(0);
    expect(read("dist/a.js")).toBe("export const a = 1;");
    expect(read("dist/c.js")).toBe("export const c = 3;");
  });
});

describe("a killed run, then a rebuild that touched only one file", () => {
  function killedRun(): void {
    viteBuild();
    const dist = join(root, "dist");
    const from = join(dist, "assets", "index-Ab3dE9fG.js");
    const to = join(dist, "assets", "index-NeWnAm3s.js");
    const lazy = join(dist, "assets", "lazy-Q1w2E3r4.js");
    beginJournal({
      slot: backupSlot(root, "dist"),
      protectedRoot: dist,
      cliVersion: "9.9.9",
      planned: new Map<string, (string | null)[]>([
        [from, [null]],
        [to, [sha("OBF:index")]],
        [lazy, [sha("OBF:lazy")]],
      ]),
      renamed: new Map([[from, to]]),
      persist: true,
    });
    writeFileSync(to, "OBF:index");
    rmSync(from);
    writeFileSync(lazy, "OBF:lazy");
  }

  it("refuses to discard the backup, naming the rebuilt file and both ways out", async () => {
    killedRun();
    write("dist/assets/lazy-Q1w2E3r4.js", "export const lazy = 2;");
    const before = tree("dist");

    expect(await invoke(["dist", ...QUIET])).toBe(1);
    const text = err.join("\n");
    expect(text).toContain("part of the output was rebuilt since");
    expect(text).toContain("dist/assets/lazy-Q1w2E3r4.js");
    expect(text).toContain("Rebuild the whole output from source");
    expect(text).toContain(".afterpack/backups/dist/current/files");
    expect(tree("dist")).toEqual(before);
    expect(existsSync(backupSlot(root, "dist").manifestPath)).toBe(true);

    err = [];
    expect(await invoke(["restore", "dist"])).toBe(1);
    expect(err.join("\n")).toContain("Rebuild the whole output from source");
    expect(tree("dist")).toEqual(before);
  });

  it("discards it once the whole output is rebuilt", async () => {
    killedRun();
    rmSync(join(root, "dist"), { recursive: true, force: true });
    viteBuild();
    write("dist/index.html", "<p>rebuilt</p>");
    expect(await invoke(["dist", ...QUIET])).toBe(0);
    expect(warnings.join("\n")).toContain("Discarded the backup");
  });
});

describe("afterpack restore <dir> in a project with several protected apps", () => {
  it("restores only the app it is pointed at", async () => {
    viteBuild("apps/web/dist");
    viteBuild("apps/admin/dist");
    const web = tree("apps/web/dist");
    expect(await invoke(["apps/web/dist", ...QUIET])).toBe(0);
    expect(await invoke(["apps/admin/dist", ...QUIET])).toBe(0);
    const admin = tree("apps/admin/dist");

    expect(await invoke(["restore", "apps/web"])).toBe(0);
    expect(tree("apps/web/dist")).toEqual(web);
    expect(tree("apps/admin/dist")).toEqual(admin);
  });

  it("lists the backups that exist when none covers the directory", async () => {
    viteBuild("apps/web/dist");
    mkdirSync(join(root, "apps", "docs"), { recursive: true });
    expect(await invoke(["apps/web/dist", ...QUIET])).toBe(0);

    expect(await invoke(["restore", "apps/docs"])).toBe(1);
    const text = err.join("\n");
    expect(text).toContain("No backup covers apps/docs");
    expect(text).toContain("backed up: apps/web/dist/");
  });
});

describe("one lock per renamed root", () => {
  function nextBuild(): void {
    write(".next/BUILD_ID", "fixture");
    mkdirSync(join(root, ".next", "turbopack"), { recursive: true });
    write(".next/static/chunks/0ghe5rzlpm1le.js", 'import("./0tjd6zdagvqu6.js")');
    write(".next/static/chunks/0tjd6zdagvqu6.js", "export const lazy = 1;");
    write(".next/build-manifest.json", '{"pages":{"/":["static/chunks/0ghe5rzlpm1le.js"]}}');
  }

  it("makes `afterpack .next` and `afterpack .next/static/chunks` contend", async () => {
    nextBuild();
    const gated = gatedEngine();
    const first = invoke([".next/static/chunks", ...QUIET], gated.engine);
    await gated.started;

    expect(await invoke([".next", ...QUIET])).toBe(1);
    expect(err.join("\n")).toContain("Another afterpack run");
    gated.release();
    expect(await first).toBe(0);
    expect(existsSync(backupSlot(root, ".next").manifestPath)).toBe(true);
  });
});

describe("a restore killed partway", () => {
  async function killedRestore(): Promise<Record<string, string>> {
    viteBuild();
    const plain = tree("dist");
    expect(await invoke(["dist", ...QUIET])).toBe(0);
    const slot = backupSlot(root, "dist");
    const result = readBackupManifest(slot);
    if (result.status !== "ok") throw new Error("expected a backup manifest");
    const html = join(root, "dist", "index.html");
    addScratch(slot, result.manifest, [`${html}.afterpack-tmp`]);
    copyFileSync(join(slot.current, "files", "dist", "index.html"), `${html}.afterpack-tmp`);
    return plain;
  }

  it("makes verify fail on the temporary file it left, which holds original source", async () => {
    await killedRestore();
    expect(await invoke(["verify", "dist"])).toBe(1);
    const text = err.join("\n");
    expect(text).toContain("temporary file");
    expect(text).toContain("dist/index.html.afterpack-tmp");
  });

  it("is finished by the next restore, which also removes the temporary file", async () => {
    const plain = await killedRestore();
    expect(await invoke(["restore"])).toBe(0);
    expect(tree("dist")).toEqual(plain);
  });

  it("has its temporary file removed by the next run", async () => {
    await killedRestore();
    await invoke(["dist", ...QUIET]);
    expect(existsSync(join(root, "dist", "index.html.afterpack-tmp"))).toBe(false);
  });
});
