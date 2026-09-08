import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterpackVite } from "@afterpack/vite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { afterpackElectron, type ElectronLeg, withAfterpackElectron } from "./index.js";
import { resetNotices } from "./notices.js";

vi.mock("@afterpack/vite", () => ({
  afterpackVite: vi.fn((options: { projectRoot?: string }) => ({
    name: "afterpack-vite",
    options,
  })),
}));

let root: string;
let outDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "afterpack-electron-test-"));
  outDir = join(root, "out");
  mkdirSync(outDir, { recursive: true });
  resetNotices();
  vi.mocked(afterpackVite).mockClear();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// biome-ignore lint/suspicious/noExplicitAny: exercising Vite hooks directly in a test.
function guardOf(plugins: any[]): any {
  return plugins[1];
}

// biome-ignore lint/suspicious/noExplicitAny: a minimal ResolvedConfig stand-in.
function resolvedConfig(plugins: { name: string }[] = []): any {
  return { root, build: { outDir }, plugins, logger: { warn: vi.fn() } };
}

describe("afterpackElectron — per-leg wiring", () => {
  it.each<[ElectronLeg]>([
    ["main"],
    ["preload"],
    ["renderer"],
  ])("names the %s leg, which is what keys its seed and its Protection Map", (leg) => {
    afterpackElectron({ leg, preset: "medium", projectRoot: root });
    expect(afterpackVite).toHaveBeenCalledWith({ preset: "medium", leg, projectRoot: root });
  });

  it("pins every leg to ONE project root — electron-vite roots the renderer at src/renderer", () => {
    withAfterpackElectron({ main: {}, renderer: {} });
    const roots = vi.mocked(afterpackVite).mock.calls.map((c) => c[0]?.projectRoot);
    expect(roots).toEqual([process.cwd(), process.cwd()]);
  });

  it("returns the obfuscation plugin followed by this leg's guard", () => {
    const plugins = afterpackElectron({ leg: "main" });
    expect(plugins.map((p) => p.name)).toEqual(["afterpack-vite", "afterpack-electron:main"]);
  });
});

describe("withAfterpackElectron — one call, every declared leg", () => {
  it("wires exactly the legs the config declares, appending to (not replacing) each leg's existing plugins", () => {
    const config = { main: {}, renderer: { plugins: [{ name: "react" }] } };
    const out = withAfterpackElectron(config, { seed: 7 });
    expect(out).toBe(config);
    expect(vi.mocked(afterpackVite).mock.calls.map((c) => c[0])).toEqual([
      { seed: 7, leg: "main", projectRoot: process.cwd() },
      { seed: 7, leg: "renderer", projectRoot: process.cwd() },
    ]);
    expect(out.renderer.plugins[0]).toEqual({ name: "react" });
    expect(out.renderer.plugins).toHaveLength(2);
  });

  it("handles the function form of an electron-vite config", () => {
    const fn = withAfterpackElectron(() => ({ main: {}, preload: {}, renderer: {} }));
    const resolved = (fn as () => { main: { plugins?: unknown[] } })();
    expect(resolved.main.plugins).toHaveLength(1);
    expect(vi.mocked(afterpackVite).mock.calls).toHaveLength(3);
  });

  it("handles the promise form of an electron-vite config", async () => {
    const resolved = await withAfterpackElectron(Promise.resolve({ main: {} }));
    expect((resolved as { main: { plugins?: unknown[] } }).main.plugins).toHaveLength(1);
  });

  it("handles an async function form", async () => {
    const fn = withAfterpackElectron(async () => ({ renderer: {} }));
    const resolved = await (fn as () => Promise<{ renderer: { plugins?: unknown[] } }>)();
    expect(resolved.renderer.plugins).toHaveLength(1);
  });

  it("throws on a plain Vite config with no leg sections at all", () => {
    expect(() => withAfterpackElectron({ plugins: [] })).toThrow(
      /no main\/preload\/renderer section/,
    );
  });
});

describe("Electron fail-closed guards", () => {
  it("REFUSES backup:true — the backup ships the original source inside app.asar", () => {
    expect(() => afterpackElectron({ leg: "main", build: { backup: true } })).toThrow(/app\.asar/);
    expect(afterpackVite).not.toHaveBeenCalled();
  });

  it("warns, but does not throw, when source maps are enabled", () => {
    afterpackElectron({ leg: "renderer", sourceMap: true });
    expect(vi.mocked(console.warn).mock.calls.flat().join("\n")).toMatch(/full deobfuscation/);
  });

  it("REFUSES a leg that also runs electron-vite's bytecodePlugin", () => {
    const guard = guardOf(afterpackElectron({ leg: "main" }));
    expect(() => guard.configResolved(resolvedConfig([{ name: "vite:bytecode" }]))).toThrow(
      /V8 bytecode/,
    );
  });

  it("REFUSES after the fact when .jsc chunks are found in the output", () => {
    const guard = guardOf(afterpackElectron({ leg: "main" }));
    guard.configResolved(resolvedConfig());
    writeFileSync(join(outDir, "index.jsc"), "bytecode");
    expect(() => guard.closeBundle()).toThrow(/1 V8 bytecode chunk\(s\)/);
  });

  it("passes cleanly when no bytecode is present", () => {
    const guard = guardOf(afterpackElectron({ leg: "renderer" }));
    guard.configResolved(resolvedConfig());
    writeFileSync(join(outDir, "index.js"), "ok");
    expect(() => guard.closeBundle()).not.toThrow();
  });

  it("warns ONCE about the packaged tree when a packager config exists", () => {
    writeFileSync(join(root, "electron-builder.yml"), "appId: test\n");
    const config = resolvedConfig();
    guardOf(afterpackElectron({ leg: "main" })).configResolved(config);
    guardOf(afterpackElectron({ leg: "preload" })).configResolved(config);
    expect(config.logger.warn).toHaveBeenCalledTimes(1);
    expect(config.logger.warn.mock.calls[0][0]).toMatch(/!\.afterpack\/\*\*/);
  });

  it("stays quiet when the project has no packager config", () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x" }));
    const config = resolvedConfig();
    guardOf(afterpackElectron({ leg: "main" })).configResolved(config);
    expect(config.logger.warn).not.toHaveBeenCalled();
  });

  it("detects a packager config declared inside package.json", () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ build: { appId: "x" } }));
    const config = resolvedConfig();
    guardOf(afterpackElectron({ leg: "main" })).configResolved(config);
    expect(config.logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe("multi-process advisory", () => {
  function exitListeners(): (() => void)[] {
    const captured: (() => void)[] = [];
    vi.spyOn(process, "on").mockImplementation(((event: string, fn: () => void) => {
      if (event === "exit") captured.push(fn);
      return process;
      // biome-ignore lint/suspicious/noExplicitAny: narrowing process.on for the spy.
    }) as any);
    return captured;
  }

  it("advises setting AFTERPACK_SEED when only ONE leg built in this process", () => {
    const listeners = exitListeners();
    const guard = guardOf(afterpackElectron({ leg: "main" }));
    guard.configResolved(resolvedConfig());
    guard.closeBundle();
    expect(listeners).toHaveLength(1);
    listeners[0]();
    expect(vi.mocked(console.warn).mock.calls.flat().join("\n")).toMatch(/AFTERPACK_SEED=git/);
  });

  it("stays quiet when every leg built in this process", () => {
    const listeners = exitListeners();
    for (const leg of ["main", "preload", "renderer"] as const) {
      const guard = guardOf(afterpackElectron({ leg }));
      guard.configResolved(resolvedConfig());
      guard.closeBundle();
    }
    listeners[0]();
    expect(vi.mocked(console.warn).mock.calls.flat().join("\n")).not.toMatch(/AFTERPACK_SEED/);
  });

  it("stays quiet when the seed is explicitly pinned", () => {
    const listeners = exitListeners();
    const guard = guardOf(afterpackElectron({ leg: "main", seed: "git" }));
    guard.configResolved(resolvedConfig());
    guard.closeBundle();
    expect(listeners).toHaveLength(0);
  });
});

describe("afterpackElectron afterpack.json", () => {
  it("REFUSES a backup:true set in afterpack.json, not just one passed as an option", () => {
    vi.spyOn(process, "cwd").mockReturnValue(root);
    writeFileSync(join(root, "afterpack.json"), JSON.stringify({ build: { backup: true } }));
    expect(() => afterpackElectron({ leg: "main" })).toThrow(/app\.asar/);
  });

  it("warns about a sourceMap:true set in afterpack.json", () => {
    vi.spyOn(process, "cwd").mockReturnValue(root);
    writeFileSync(join(root, "afterpack.json"), JSON.stringify({ sourceMap: { enabled: true } }));
    afterpackElectron({ leg: "renderer" });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("source maps are enabled"));
  });
});
