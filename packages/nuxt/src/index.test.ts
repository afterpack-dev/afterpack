import { afterpackVite } from "@afterpack/vite";
import { addVitePlugin } from "@nuxt/kit";
import { describe, expect, it, vi } from "vitest";
import afterpackNuxtModule from "./index.js";

vi.mock("@nuxt/kit", () => ({
  defineNuxtModule: vi.fn((definition) => definition),
  addVitePlugin: vi.fn(),
}));
vi.mock("@afterpack/vite", () => ({
  afterpackVite: vi.fn(() => ({ name: "afterpack-vite" })),
}));

const moduleDef = afterpackNuxtModule as unknown as {
  meta: { name: string; configKey: string };
  setup: (options: unknown, nuxt: unknown) => void;
};

describe("@afterpack/nuxt module", () => {
  it("declares the afterpack config key", () => {
    expect(moduleDef.meta.name).toBe("@afterpack/nuxt");
    expect(moduleDef.meta.configKey).toBe("afterpack");
  });

  it("registers a vite plugin factory that forwards options to afterpackVite", () => {
    const options = { seed: 42, preset: "medium" } as const;
    moduleDef.setup(options, {});

    expect(addVitePlugin).toHaveBeenCalledTimes(1);
    const factory = vi.mocked(addVitePlugin).mock.calls[0][0] as () => unknown;
    expect(typeof factory).toBe("function");

    const plugin = factory();
    expect(afterpackVite).toHaveBeenCalledWith(options);
    expect(plugin).toEqual({ name: "afterpack-vite" });
  });
});
