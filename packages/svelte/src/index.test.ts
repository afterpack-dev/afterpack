import { afterpackVite } from "@afterpack/vite";
import { describe, expect, it, vi } from "vitest";
import { afterpackSvelte } from "./index.js";

vi.mock("@afterpack/vite", () => ({
  afterpackVite: vi.fn(() => ({ name: "afterpack-vite" })),
}));

describe("afterpackSvelte", () => {
  it("forwards options verbatim to afterpackVite and returns its plugin", () => {
    const options = { seed: "git", preset: "hard", build: { autorun: false } } as const;
    const plugin = afterpackSvelte(options);
    expect(afterpackVite).toHaveBeenCalledWith(options);
    expect(plugin).toEqual({ name: "afterpack-vite" });
  });

  it("defaults to an empty options object", () => {
    afterpackSvelte();
    expect(afterpackVite).toHaveBeenCalledWith({});
  });
});
