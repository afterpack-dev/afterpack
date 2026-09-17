import { readFileSync } from "node:fs";
import { withAfterpack } from "@afterpack/next";
import type { NextConfig } from "next";

const expectations = JSON.parse(readFileSync(new URL("./expectations.json", import.meta.url), "utf8"));

const nextConfig: NextConfig = {
  distDir: process.env.AFTERPACK_E2E_DIST_DIR ?? ".next",

  // Same reason as ../next-16/: Next.js generates a fresh random buildId per
  // build, embedded in manifests and prerendered pages, which would break the
  // determinism comparison for reasons unrelated to obfuscation.
  generateBuildId: async () => "afterpack-fixture-build",
};

// Same wiring as ../next-16/: the obfuscation runs inside `next build` via
// Next's `compiler.runAfterProductionCompile` hook, with no postbuild script.
export default withAfterpack(nextConfig, { seed: expectations.seed });
