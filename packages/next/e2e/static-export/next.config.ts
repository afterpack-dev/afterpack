import { readFileSync } from "node:fs";
import { withAfterpack } from "@afterpack/next";
import type { NextConfig } from "next";

const expectations = JSON.parse(readFileSync(new URL("./expectations.json", import.meta.url), "utf8"));

const nextConfig: NextConfig = {
  distDir: process.env.AFTERPACK_E2E_DIST_DIR ?? ".next",

  // The whole point of this fixture (see next-static-export.spec.ts):
  // fully static HTML/JS output, zero server runtime at request time.
  // The export copies .next/static into out/_next/static AFTER
  // runAfterProductionCompile, so obfuscating the chunks in the hook is what
  // puts obfuscated code in the shipped out/ tree -- and the receipt check in
  // next-static-export.spec.ts asserts the two copies are byte-identical.
  output: "export",

  // Same reasoning as next-16/next.config.ts: pin the build id so two
  // builds with the same seed are byte-for-byte comparable (the
  // obfuscation-happened/determinism check), unrelated to obfuscation
  // itself -- Next.js otherwise embeds a fresh random id into
  // out/_next/static/<buildId>/... on every build.
  generateBuildId: async () => "afterpack-fixture-build",
};

export default withAfterpack(nextConfig, { seed: expectations.seed });
