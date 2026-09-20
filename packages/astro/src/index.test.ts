import { afterpackVite } from "@afterpack/vite";
import { describe, expect, it, vi } from "vitest";
import afterpackDefault, { afterpackAstro } from "./index.js";

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

    expect(afterpackVite).toHaveBeenCalledWith({
      seed: 99,
      strings: {
        preserveLiterals: [
          "KEEP_ME",
          "@@ASTRO_MANIFEST_REPLACE@@",
          "@@ASTRO-LINKS@@",
          "@@ASTRO-STYLES@@",
          "$$server-islands-map$$",
          "$$server-islands-name-map$$",
        ],
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

  it("pins Astro's post-build placeholders even with no user-provided preserveLiterals", () => {
    afterpackAstro().hooks["astro:config:setup"]({
      updateConfig: () => {},
    });

    expect(afterpackVite).toHaveBeenCalledWith({
      strings: {
        preserveLiterals: [
          "@@ASTRO_MANIFEST_REPLACE@@",
          "@@ASTRO-LINKS@@",
          "@@ASTRO-STYLES@@",
          "$$server-islands-map$$",
          "$$server-islands-name-map$$",
        ],
      },
    });
  });

  it("is also the default export", () => {
    expect(afterpackDefault).toBe(afterpackAstro);
  });
});
