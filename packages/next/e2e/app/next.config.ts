import { readFileSync } from "node:fs";
import { withAfterpackNext } from "@afterpack/next";
import type { NextConfig } from "next";

const expectations = JSON.parse(readFileSync(new URL("./expectations.json", import.meta.url), "utf8"));

const nextConfig: NextConfig = {
  distDir: process.env.AFTERPACK_E2E_DIST_DIR ?? ".next",

  // Next.js generates a fresh random buildId on every `next build` by
  // default, embedded into middleware-build-manifest.js and every
  // prerendered .html/.rsc page -- entirely unrelated to obfuscation, but
  // enough to make a build-to-build determinism comparison fail for reasons
  // that have nothing to do with AfterPack. Fixed here so this fixture's
  // own determinism check (e2e/helpers/build.ts) is comparing like-for-like.
  generateBuildId: async () => "afterpack-fixture-build",
};

// withAfterpackNext installs Next's own `compiler.runAfterProductionCompile`
// hook, which runs INSIDE `next build` on either bundler. There is no
// postbuild script and no bin: `npm run build` alone leaves .next/static/chunks
// obfuscated, and the build writes .next/.afterpack-protection.json recording
// what it protected. This fixture's package.json deliberately has no
// "postbuild" -- e2e/helpers/receipt.ts fails if one comes back.
export default withAfterpackNext(nextConfig, { seed: expectations.seed });
