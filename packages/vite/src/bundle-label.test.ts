import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as utils from "@afterpack/integration-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __reset } from "../../../test/core-fake.js";
import { resetBuildSessions } from "../../integration-utils/src/seed.js";
import { viteBundleLabel } from "./bundle-label.js";
import { afterpackVite } from "./index.js";

vi.mock("@afterpack/integration-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof utils>();
  return { ...actual, runObfuscationPass: vi.fn(actual.runObfuscationPass) };
});

const root = join(tmpdir(), "app");

describe("viteBundleLabel", () => {
  const base = { root, framework: undefined, environment: "client", leg: undefined };

  it("is the config file relative to the project root", () => {
    expect(viteBundleLabel({ ...base, configFile: join(root, "vite.config.ts") })).toBe(
      "vite.config.ts",
    );
    expect(viteBundleLabel({ ...base, configFile: join(root, "vite.landing.config.ts") })).toBe(
      "vite.landing.config.ts",
    );
    expect(
      viteBundleLabel({ ...base, configFile: join(root, "config", "vite.admin.config.ts") }),
    ).toBe("config/vite.admin.config.ts");
  });

  it("suffixes an SSR build, or any environment other than the client", () => {
    const configFile = join(root, "vite.config.ts");
    expect(viteBundleLabel({ ...base, configFile, environment: "ssr" })).toBe(
      "vite.config.ts (ssr)",
    );
    expect(viteBundleLabel({ ...base, configFile, environment: "edge" })).toBe(
      "vite.config.ts (edge)",
    );
  });

  it("uses only the basename of a config file outside the root, never an absolute path", () => {
    const label = viteBundleLabel({
      ...base,
      root: join(root, "src"),
      configFile: join(root, "vite.config.ts"),
    });
    expect(label).toBe("vite.config.ts");
  });

  it("names the framework and environment when the config is inline", () => {
    for (const environment of ["client", "ssr", "prerender"]) {
      expect(
        viteBundleLabel({ ...base, configFile: undefined, framework: "astro", environment }),
      ).toBe(`astro (${environment})`);
    }
    expect(viteBundleLabel({ ...base, configFile: undefined })).toBe("vite (client)");
  });

  it("names the leg in place of the environment", () => {
    expect(
      viteBundleLabel({
        ...base,
        configFile: undefined,
        framework: "electron",
        environment: "ssr",
        leg: "main",
      }),
    ).toBe("electron (main)");
    expect(
      viteBundleLabel({ ...base, configFile: join(root, "vite.config.ts"), leg: "renderer" }),
    ).toBe("vite.config.ts (renderer)");
  });
});

describe("afterpackVite hands the pass its bundle label", () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "afterpack-vite-label-"));
    writeFileSync(join(project, "package.json"), "{}");
    writeFileSync(join(project, ".gitignore"), "");
    mkdirSync(join(project, "dist"), { recursive: true });
    resetBuildSessions();
    __reset();
    vi.mocked(utils.runObfuscationPass).mockClear();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function labelOf(
    config: Record<string, unknown>,
    context: Record<string, unknown>,
    framework?: string,
  ): Promise<string | undefined> {
    // biome-ignore lint/suspicious/noExplicitAny: exercising Vite hooks directly in a test.
    const p = afterpackVite({}, { framework }) as any;
    const outDir = join(project, "dist");
    p.configResolved({ root: project, command: "build", build: { outDir }, ...config });
    await p.buildStart.call({});
    const bundle = { "a.js": { type: "chunk", fileName: "a.js", code: "export const a = 1;" } };
    await p.generateBundle.handler.call(context, { dir: outDir }, bundle);
    return vi.mocked(utils.runObfuscationPass).mock.calls[0][0].bundle;
  }

  it("from the resolved config file and the Vite environment", async () => {
    const configFile = join(project, "vite.landing.config.ts");
    expect(await labelOf({ configFile }, { environment: { name: "client" } })).toBe(
      "vite.landing.config.ts",
    );
    vi.mocked(utils.runObfuscationPass).mockClear();
    expect(await labelOf({ configFile }, { environment: { name: "ssr" } })).toBe(
      "vite.landing.config.ts (ssr)",
    );
  });

  it("from the framework and environment when the config is inline", async () => {
    expect(await labelOf({}, { environment: { name: "prerender" } }, "astro")).toBe(
      "astro (prerender)",
    );
  });

  it("from build.ssr when the hook context names no environment", async () => {
    const configFile = join(project, "vite.config.ts");
    expect(
      await labelOf({ configFile, build: { outDir: join(project, "dist"), ssr: true } }, {}),
    ).toBe("vite.config.ts (ssr)");
  });
});
