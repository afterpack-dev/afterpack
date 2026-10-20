import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,
  buildDirectory: process.env.AFTERPACK_E2E_DIST_DIR || "build",
} satisfies Config;
