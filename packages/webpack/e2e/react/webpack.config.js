import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AfterpackWebpackPlugin } from "@afterpack/webpack";
import HtmlWebpackPlugin from "html-webpack-plugin";

const HERE = dirname(fileURLToPath(import.meta.url));
const expectations = JSON.parse(readFileSync(new URL("./expectations.json", import.meta.url), "utf8"));

// Real webpack 5 config for a minimal React app. AfterpackWebpackPlugin taps
// processAssets to obfuscate the bundle IN THE PIPELINE, before webpack writes
// it; it honors AFTERPACK_build_autorun=false (the smoke test's un-obfuscated
// baseline) itself, so no branch is needed here. Seed is pinned from
// expectations.json for determinism.
export default {
  mode: "production",
  entry: resolve(HERE, "src/index.jsx"),
  devtool: false,
  output: {
    path: resolve(HERE, "dist"),
    filename: "[name].[contenthash].js",
    clean: true,
  },
  resolve: { extensions: [".js", ".jsx"] },
  module: {
    rules: [
      {
        test: /\.jsx?$/,
        exclude: /node_modules/,
        use: {
          loader: "babel-loader",
          options: {
            presets: [
              ["@babel/preset-env", { targets: "defaults" }],
              ["@babel/preset-react", { runtime: "automatic" }],
            ],
          },
        },
      },
    ],
  },
  plugins: [
    new HtmlWebpackPlugin({ template: resolve(HERE, "src/index.html") }),
    new AfterpackWebpackPlugin({ seed: expectations.seed }),
  ],
};
