import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { collectJsFiles } from "@afterpack/integration-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectHashedLayout,
  KEPT_NAMES_NOTICE,
  keptNamesNotice,
  type LayoutDecision,
  looksContentHashed,
} from "../src/layout.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "afterpack-layout-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, text = "x"): string {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function detect(rel: string): LayoutDecision {
  const target = join(root, rel);
  return detectHashedLayout(target, true, collectJsFiles(target));
}

function renamed(decision: LayoutDecision) {
  if (decision.status !== "rename") throw new Error(`expected a rename, got ${decision.status}`);
  return decision.layout;
}

function tokenOf(decision: LayoutDecision, rel: string): string | null {
  return renamed(decision).hashedNames.tokenOf(rel);
}

function viteTree(): void {
  write(
    "dist/index.html",
    '<script type="module" src="/assets/index-Ab3dE9fG.js"></script>' +
      '<link rel="stylesheet" href="/assets/index-Zz9yX8wV.css">',
  );
  write("dist/assets/index-Ab3dE9fG.js", 'import("./lazy-Q1w2E3r4.js")');
  write("dist/assets/lazy-Q1w2E3r4.js", "export const lazy = 1;");
  write("dist/assets/index-Zz9yX8wV.css", "body{}");
}

describe("detectHashedLayout — Next.js", () => {
  function nextTree(distDir = ".next"): void {
    write(`${distDir}/BUILD_ID`, "build-1");
    mkdirSync(join(root, distDir, "turbopack"), { recursive: true });
    write(`${distDir}/static/chunks/0ghe5rzlpm1le.js`);
    write(`${distDir}/static/chunks/turbopack-110_x8koxl235.js`);
    write(`${distDir}/server/app/page.js`, "0ghe5rzlpm1le.js");
  }

  it.each([
    ".next",
    ".next/static",
    ".next/static/chunks",
  ])("recognises %s and roots the rewrite at the dist dir", (rel) => {
    nextTree();
    const layout = renamed(detect(rel));
    expect(layout.kind).toBe("next");
    expect(layout.hashedNames.root).toBe(join(root, ".next"));
    expect(layout.hashedNames.tokenOf("static/chunks/0ghe5rzlpm1le.js")).toBe("0ghe5rzlpm1le");
    expect(layout.hashedNames.tokenOf("server/app/page.js")).toBeNull();
    expect(layout.hashedNames.skip?.("cache")).toBe(true);
  });

  it("recognises a custom distDir by its markers, not its name", () => {
    nextTree("build-out");
    expect(renamed(detect("build-out")).kind).toBe("next");
  });

  it("reads a webpack build's 16-hex chunk names", () => {
    write(".next/BUILD_ID", "b");
    write(".next/server/webpack-runtime.js");
    write(".next/static/chunks/main-app-0123456789abcdef.js");
    expect(tokenOf(detect(".next"), "static/chunks/main-app-0123456789abcdef.js")).toBe(
      "0123456789abcdef",
    );
  });

  it("keeps names when it cannot tell the bundler", () => {
    write(".next/BUILD_ID", "b");
    write(".next/static/chunks/main-app-0123456789abcdef.js");
    expect(detect(".next")).toEqual({ status: "keep" });
  });

  it("recognises a static export out/ and reads its _next/static/chunks names", () => {
    write("out/index.html", '<script src="/_next/static/chunks/0ghe5rzlpm1le.js"></script>');
    write("out/_next/static/chunks/0ghe5rzlpm1le.js");
    write("out/_next/static/chunks/turbopack-110_x8koxl235.js");
    const decision = detect("out");
    expect(renamed(decision).kind).toBe("next-export");
    expect(tokenOf(decision, "_next/static/chunks/0ghe5rzlpm1le.js")).toBe("0ghe5rzlpm1le");
    expect(tokenOf(decision, "static/chunks/0ghe5rzlpm1le.js")).toBeNull();
  });
});

describe("detectHashedLayout — Angular", () => {
  function angularTree(): void {
    write("dist/app/browser/index.html", '<script src="main-ABCD1234.js" type="module"></script>');
    write("dist/app/browser/main-ABCD1234.js", 'import"./chunk-EFGH5678.js"');
    write("dist/app/browser/chunk-EFGH5678.js");
  }

  it.each([
    "dist/app/browser",
    "dist/app",
  ])("recognises %s and roots the rewrite at the application output", (rel) => {
    angularTree();
    const layout = renamed(detect(rel));
    expect(layout.kind).toBe("angular");
    expect(layout.hashedNames.root).toBe(join(root, "dist/app"));
    expect(layout.angular).toEqual({
      outputRoot: join(root, "dist/app"),
      browserDir: join(root, "dist/app/browser"),
    });
    expect(layout.hashedNames.tokenOf("browser/chunk-EFGH5678.js")).toBe("EFGH5678");
  });

  it("refuses an SSR build whose server manifest pins asset hashes", () => {
    angularTree();
    write("dist/app/server/angular-app-manifest.mjs", "export default { hash: 'abc' }");
    const decision = detect("dist/app/browser");
    expect(decision.status).toBe("refuse");
  });
});

describe("detectHashedLayout — Vite", () => {
  it("recognises dist/ with an index.html and reads 8-character hashes under assets/", () => {
    viteTree();
    const decision = detect("dist");
    expect(renamed(decision).kind).toBe("vite");
    expect(tokenOf(decision, "assets/index-Ab3dE9fG.js")).toBe("Ab3dE9fG");
    expect(tokenOf(decision, "assets/index-Zz9yX8wV.css")).toBe("Zz9yX8wV");
    expect(tokenOf(decision, "assets/app-settings.js")).toBeNull();
    expect(tokenOf(decision, "index-Ab3dE9fG.js")).toBeNull();
  });

  it("recognises a manifest-only build and takes the hashed directories from it", () => {
    write(
      "dist/.vite/manifest.json",
      JSON.stringify({ "main.js": { file: "static/main-Ab3dE9fG.js" } }),
    );
    write("dist/static/main-Ab3dE9fG.js");
    const decision = detect("dist");
    expect(tokenOf(decision, "static/main-Ab3dE9fG.js")).toBe("Ab3dE9fG");
  });

  it("follows a non-root base path in index.html to the hashed directory", () => {
    write("dist/index.html", '<script type="module" src="/app/js/index-Ab3dE9fG.js"></script>');
    write("dist/js/index-Ab3dE9fG.js");
    expect(tokenOf(detect("dist"), "js/index-Ab3dE9fG.js")).toBe("Ab3dE9fG");
  });

  it("keeps names when a hashed file is referenced from nowhere in the tree", () => {
    viteTree();
    write("dist/assets/worker-P0o9I8u7.js");
    expect(detect("dist")).toEqual({ status: "keep" });
  });

  it("keeps names when a hash cannot be told from a word", () => {
    viteTree();
    write("dist/assets/vendor-abcdefgh.js");
    write("dist/other.html", '<script src="/assets/vendor-abcdefgh.js"></script>');
    expect(detect("dist")).toEqual({ status: "keep" });
  });
});

describe("detectHashedLayout — names referenced from outside the output", () => {
  function remixLike(): void {
    write("build/client/assets/entry-Ab3dE9fG.js", 'import("./route-Q1w2E3r4.js")');
    write("build/client/assets/route-Q1w2E3r4.js", "export default 1;");
    write(
      "build/client/.vite/manifest.json",
      JSON.stringify({ a: { file: "assets/entry-Ab3dE9fG.js" } }),
    );
    write("build/client/index.html", '<script src="/assets/entry-Ab3dE9fG.js"></script>');
  }

  it("keeps names when a server bundle beside the client hard-codes them", () => {
    remixLike();
    const server = write("build/server/index.js", 'const entry = "/assets/route-Q1w2E3r4.js";');
    expect(detect("build/client")).toEqual({
      status: "keep",
      reason: { kind: "outside-reference", path: server, target: join(root, "build/client") },
    });
  });

  it("renames when the server bundle names none of them", () => {
    remixLike();
    write("build/server/index.js", "export const handler = 1;");
    expect(detect("build/client").status).toBe("rename");
  });

  it("looks inside known server dot-folders beside a project-root output", () => {
    viteTree();
    write("package.json", "{}");
    write(".git/HEAD", "assets/index-Ab3dE9fG.js");
    expect(detect("dist").status).toBe("rename");
    const server = write(".svelte-kit/output/server/index.js", '"/assets/lazy-Q1w2E3r4.js"');
    expect(detect("dist")).toMatchObject({ status: "keep", reason: { path: server } });
  });

  it("checks only build-output folders beside a project-root output, never the source", () => {
    viteTree();
    write("package.json", "{}");
    write("src/notes.js", "// mentions index-Ab3dE9fG.js");
    expect(detect("dist").status).toBe("rename");
    const ssr = write("dist-ssr/entry.js", '"/assets/lazy-Q1w2E3r4.js"');
    expect(detect("dist")).toMatchObject({ status: "keep", reason: { path: ssr } });
  });
});

describe("detectHashedLayout — service-worker precache manifests", () => {
  it("keeps names when a Workbox precache lists files by revision", () => {
    viteTree();
    const sw = write(
      "dist/sw.js",
      'precacheAndRoute([{url:"index.html",revision:"3f2a1b"},{url:"assets/index-Ab3dE9fG.js",revision:null}])',
    );
    expect(detect("dist")).toEqual({ status: "keep", reason: { kind: "precache", path: sw } });
  });

  it("looks for a Next.js service worker in public/ too", () => {
    write(".next/BUILD_ID", "b");
    mkdirSync(join(root, ".next", "turbopack"), { recursive: true });
    write(".next/static/chunks/0ghe5rzlpm1le.js");
    const sw = write(
      "public/sw.js",
      '[{"revision":"abc","url":"/_next/static/chunks/0ghe5rzlpm1le.js"}]',
    );
    expect(detect(".next")).toMatchObject({
      status: "keep",
      reason: { kind: "precache", path: sw },
    });
  });
});

describe("keptNamesNotice", () => {
  it("says why the names were kept, then what to do", () => {
    const text = keptNamesNotice(
      { kind: "outside-reference", path: "/p/build/server/index.js", target: "/p/build/client" },
      (path) => path.replace("/p/", ""),
    );
    expect(text).toBe(
      `build/server/index.js names files in build/client, so renaming them would break it. ${KEPT_NAMES_NOTICE}`,
    );
  });
});

describe("detectHashedLayout — webpack", () => {
  function webpackTree(): void {
    write("dist/index.html", '<script src="main.3f2a1b4c5d6e7f80.js"></script>');
    write(
      "dist/main.3f2a1b4c5d6e7f80.js",
      'self.webpackChunkapp=self.webpackChunkapp||[];o.u=e=>""+e+"."+{12:"a1b2c3d4e5f60718"}[e]+".js"',
    );
    write(
      "dist/12.a1b2c3d4e5f60718.js",
      "(self.webpackChunkapp=self.webpackChunkapp||[]).push([])",
    );
  }

  it("recognises split chunks loaded through the runtime's chunk map", () => {
    webpackTree();
    const decision = detect("dist");
    expect(renamed(decision).kind).toBe("webpack");
    expect(tokenOf(decision, "12.a1b2c3d4e5f60718.js")).toBe("a1b2c3d4e5f60718");
  });

  it("keeps names when a chunk hash is all digits and could match an unrelated number", () => {
    webpackTree();
    write("dist/7.12345678.js", "x");
    write("dist/other.html", "7.12345678.js");
    expect(detect("dist")).toEqual({ status: "keep" });
  });

  it("does not take hex-named files for webpack output without the webpack runtime", () => {
    write("dist/main.3f2a1b4c5d6e7f80.js", "console.log(1)");
    write("dist/index.html", "main.3f2a1b4c5d6e7f80.js");
    expect(detect("dist")).toEqual({ status: "keep" });
  });
});

describe("detectHashedLayout — everything else", () => {
  it("is plain for output whose names carry no content hash", () => {
    write("dist/index.html", '<script src="main.js"></script>');
    write("dist/main.js");
    write("dist/lodash-debounce.js");
    expect(detect("dist")).toEqual({ status: "plain" });
  });

  it("keeps hashed names it has no reader for", () => {
    write("dist/_app/immutable/chunks/entry.DdA1bC2e.js");
    expect(detect("dist")).toEqual({ status: "keep" });
  });

  it("never renames a single-file target", () => {
    const file = write("dist/assets/index-Ab3dE9fG.js");
    expect(detectHashedLayout(file, false, [file])).toEqual({ status: "keep" });
  });

  it.each([
    ["index-Ab3dE9fG.js", true],
    ["main.3f2a1b4c5d6e7f80.js", true],
    ["0ghe5rzlpm1le.js", true],
    ["chunk-EFGH5678.js", true],
    ["BXmT3Xyz.js", true],
    ["chunk123.js", false],
    ["app.js", false],
    ["lodash-debounce.js", false],
    ["jquery-3.7.1.min.js", false],
  ])("looksContentHashed(%s) is %s", (name, hashed) => {
    expect(looksContentHashed([join(root, name)])).toBe(hashed);
  });
});
