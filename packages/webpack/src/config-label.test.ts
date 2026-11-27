import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { webpackConfigFileLabel } from "./config-label.js";

let root: string;
const cli = (...args: string[]) => [
  "node",
  join(root, "node_modules", "webpack-cli", "bin", "cli.js"),
  ...args,
];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "afterpack-webpack-label-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("webpackConfigFileLabel", () => {
  it("is the --config file relative to the project, in every flag spelling", () => {
    for (const args of [
      ["--config", "webpack.landing.config.js"],
      ["--config=webpack.landing.config.js"],
      ["-c", "webpack.landing.config.js"],
      ["build", "-c=webpack.landing.config.js", "--mode", "production"],
    ]) {
      expect(webpackConfigFileLabel(cli(...args), root, root)).toBe("webpack.landing.config.js");
    }
    expect(webpackConfigFileLabel(cli("-c", "configs/app.js"), root, root)).toBe("configs/app.js");
  });

  it("is only the basename for a config outside the project, never an absolute path", () => {
    expect(
      webpackConfigFileLabel(cli("--config", join(root, "..", "shared.config.js")), root, root),
    ).toBe("shared.config.js");
  });

  it("joins several --config files", () => {
    expect(webpackConfigFileLabel(cli("-c", "base.js", "-c", "landing.js"), root, root)).toBe(
      "base.js + landing.js",
    );
  });

  it("falls back to the default config file webpack-cli would load", () => {
    expect(webpackConfigFileLabel(cli(), root, root)).toBeUndefined();
    mkdirSync(join(root, ".webpack"));
    writeFileSync(join(root, ".webpack", "webpack.config.js"), "");
    expect(webpackConfigFileLabel(cli(), root, root)).toBe(".webpack/webpack.config.js");
    writeFileSync(join(root, "webpack.config.ts"), "");
    expect(webpackConfigFileLabel(cli("--mode", "production"), root, root)).toBe(
      "webpack.config.ts",
    );
  });

  it("recognises the webpack bins and ignores any other process", () => {
    writeFileSync(join(root, "webpack.config.js"), "");
    for (const bin of [
      join(root, "node_modules", "webpack", "bin", "webpack.js"),
      join(root, "node_modules", ".bin", "webpack"),
    ]) {
      expect(webpackConfigFileLabel(["node", bin], root, root)).toBe("webpack.config.js");
    }
    expect(
      webpackConfigFileLabel(["node", join(root, "build.js"), "--config", "x.js"], root, root),
    ).toBeUndefined();
    expect(webpackConfigFileLabel(["node"], root, root)).toBeUndefined();
  });
});
