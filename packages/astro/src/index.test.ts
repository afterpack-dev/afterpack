import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AfterpackConfig, resolvePluginConfig } from "@afterpack/integration-utils";
import { afterpackVite } from "@afterpack/vite";
import { describe, expect, it, vi } from "vitest";
import afterpackDefault, { afterpackAstro } from "./index.js";
import { ASTRO_POST_BUILD_PLACEHOLDERS } from "./placeholders.js";

vi.mock("@afterpack/vite", () => ({
  afterpackVite: vi.fn(() => ({ name: "afterpack-vite" })),
}));

describe("afterpackAstro", () => {
  it("returns an integration named @afterpack/astro with the config:setup hook", () => {
    const integration = afterpackAstro();
    expect(integration.name).toBe("@afterpack/astro");
    expect(typeof integration.hooks["astro:config:setup"]).toBe("function");
  });

  it("injects the client vite plugin and forwards options verbatim on config:setup", () => {
    const options = { seed: 99, preset: "medium" } as const;
    const integration = afterpackAstro(options);

    let received: { vite?: { plugins?: unknown[] } } | undefined;
    integration.hooks["astro:config:setup"]({
      updateConfig: (config) => {
        received = config;
      },
    });

    expect(afterpackVite).toHaveBeenCalledWith(options);
    expect(received?.vite?.plugins).toHaveLength(2);
    expect((received?.vite?.plugins as { name: string }[])[0].name).toBe("afterpack-vite");
  });

  it("applies the first plugin only to the client environment", () => {
    let received: { vite?: { plugins?: unknown[] } } | undefined;
    afterpackAstro().hooks["astro:config:setup"]({
      updateConfig: (config) => {
        received = config;
      },
    });

    const plugin = (
      received?.vite?.plugins as {
        applyToEnvironment: (e: { name: string }) => boolean;
      }[]
    )[0];
    expect(plugin.applyToEnvironment({ name: "client" })).toBe(true);
    expect(plugin.applyToEnvironment({ name: "ssr" })).toBe(false);
    expect(plugin.applyToEnvironment({ name: "prerender" })).toBe(false);
  });

  it("registers a second plugin for the ssr and prerender environments, pinning Astro's post-build placeholders", () => {
    const options = { seed: 99, strings: { preserveLiterals: ["KEEP_ME"] } };
    let received: { vite?: { plugins?: unknown[] } } | undefined;
    afterpackAstro(options).hooks["astro:config:setup"]({
      updateConfig: (config) => {
        received = config;
      },
    });

    expect(afterpackVite).toHaveBeenCalledWith(options, {
      appendLists: {
        strings: {
          preserveLiterals: [
            "@@ASTRO_MANIFEST_REPLACE@@",
            "@@ASTRO-LINKS@@",
            "@@ASTRO-STYLES@@",
            "$$server-islands-map$$",
            "$$server-islands-name-map$$",
          ],
        },
      },
    });

    const serverPlugin = (
      received?.vite?.plugins as {
        applyToEnvironment: (e: { name: string }) => boolean;
      }[]
    )[1];
    expect(serverPlugin.applyToEnvironment({ name: "ssr" })).toBe(true);
    expect(serverPlugin.applyToEnvironment({ name: "prerender" })).toBe(true);
    expect(serverPlugin.applyToEnvironment({ name: "client" })).toBe(false);
  });

  it("keeps the afterpack.json and environment lists on the server leg, then adds the placeholders", () => {
    afterpackAstro().hooks["astro:config:setup"]({ updateConfig: () => {} });
    const serverCall = vi.mocked(afterpackVite).mock.calls.find((call) => call.length > 1);
    const appendLists = (serverCall?.[1] as { appendLists?: AfterpackConfig }).appendLists;
    const cwd = mkdtempSync(join(tmpdir(), "afterpack-astro-"));
    try {
      writeFileSync(
        join(cwd, "afterpack.json"),
        JSON.stringify({ strings: { preserveLiterals: ["FROM_FILE"] } }),
      );
      const fromFile = resolvePluginConfig({ label: "afterpack-vite", cwd, env: {}, appendLists });
      expect(fromFile.engineConfig.strings?.preserveLiterals).toEqual([
        "FROM_FILE",
        ...ASTRO_POST_BUILD_PLACEHOLDERS,
      ]);
      const fromEnv = resolvePluginConfig({
        label: "afterpack-vite",
        cwd,
        env: { AFTERPACK_STRINGS_PRESERVE_LITERALS: "FROM_ENV" },
        appendLists,
      });
      expect(fromEnv.engineConfig.strings?.preserveLiterals).toEqual([
        "FROM_ENV",
        ...ASTRO_POST_BUILD_PLACEHOLDERS,
      ]);
      const reset = resolvePluginConfig({
        label: "afterpack-vite",
        cwd,
        env: { AFTERPACK_STRINGS_PRESERVE_LITERALS: "" },
        appendLists,
      });
      expect(reset.engineConfig.strings?.preserveLiterals).toEqual(ASTRO_POST_BUILD_PLACEHOLDERS);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("is also the default export", () => {
    expect(afterpackDefault).toBe(afterpackAstro);
  });
});
