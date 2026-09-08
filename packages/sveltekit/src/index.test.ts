import { afterpackVite } from "@afterpack/vite";
import { describe, expect, it, vi } from "vitest";
import { afterpackSveltekit } from "./index.js";

vi.mock("@afterpack/vite", () => ({
  afterpackVite: vi.fn(() => ({ name: "afterpack-vite" })),
}));

describe("afterpackSveltekit", () => {
  it("forwards options verbatim to afterpackVite and returns its plugin", () => {
    const options = { seed: 7, preset: "extreme", protectionMap: false } as const;
    const plugin = afterpackSveltekit(options);
    expect(afterpackVite).toHaveBeenCalledWith(options);
    expect(plugin).toEqual({ name: "afterpack-vite" });
  });

  it("defaults to an empty options object", () => {
    afterpackSveltekit();
    expect(afterpackVite).toHaveBeenCalledWith({});
  });
});
