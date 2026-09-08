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

  it("injects the vite plugin and forwards options verbatim on config:setup", () => {
    const options = { seed: 99, preset: "medium" } as const;
    const integration = afterpackAstro(options);

    let received: { vite?: { plugins?: unknown[] } } | undefined;
    integration.hooks["astro:config:setup"]({
      updateConfig: (config) => {
        received = config;
      },
    });

    expect(afterpackVite).toHaveBeenCalledWith(options);
    expect(received?.vite?.plugins).toHaveLength(1);
    expect((received?.vite?.plugins as { name: string }[])[0].name).toBe("afterpack-vite");
  });

  it("applies only to the client environment, skipping ssr chunks Astro rewrites after the build completes", () => {
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
  });

  it("is also the default export", () => {
    expect(afterpackDefault).toBe(afterpackAstro);
  });
});
