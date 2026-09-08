import { afterpackVite } from "@afterpack/vite";
import { describe, expect, it, vi } from "vitest";
import { afterpackVue } from "./index.js";

vi.mock("@afterpack/vite", () => ({
  afterpackVite: vi.fn(() => ({ name: "afterpack-vite" })),
}));

describe("afterpackVue", () => {
  it("forwards options verbatim to afterpackVite and returns its plugin", () => {
    const options = { seed: 42, preset: "medium", build: { autorun: false } } as const;
    const plugin = afterpackVue(options);
    expect(afterpackVite).toHaveBeenCalledWith(options);
    expect(plugin).toEqual({ name: "afterpack-vite" });
  });

  it("defaults to an empty options object", () => {
    afterpackVue();
    expect(afterpackVite).toHaveBeenCalledWith({});
  });
});
