import { describe, expect, it } from "vitest";
import { configSample, nest } from "./config-probe.js";
import { resolvePluginConfig } from "./plugin-config.js";
import { CONFIG_KEYS, getPath } from "./registry.js";

const PROBED = CONFIG_KEYS.filter((k) => k.shape !== "structured" || k.item.kind === "region");

describe("every accepted config key reaches something", () => {
  it.each(PROBED.map((k) => [k.path, k] as const))("%s", (path, key) => {
    const viaEnv = path === "key";
    const env: Record<string, string | undefined> = viaEnv
      ? { AFTERPACK_key: "ap_live_probe" }
      : {};
    let resolved: ReturnType<typeof resolvePluginConfig>;
    try {
      resolved = resolvePluginConfig({
        label: "afterpack-vite",
        cwd: process.cwd(),
        env,
        options: viaEnv ? {} : (nest(path, configSample(key)?.value) as never),
      });
    } catch {
      return;
    }

    if (viaEnv) {
      expect(
        env.AFTERPACK_KEY,
        "`key` was accepted but never converged onto AFTERPACK_KEY — the engine " +
          "reads only that variable, so this build runs FREE while the user paid",
      ).toBe("ap_live_probe");
      return;
    }
    const view = resolved.options as never as { artifactOptions?: unknown };
    const landed =
      key.surface === "engine"
        ? getPath(resolved.engineConfig as never, path) !== undefined
        : getPath(resolved.options as never, path) !== undefined ||
          getPath((view.artifactOptions ?? {}) as never, path) !== undefined;

    expect(
      landed,
      `\`${path}\` (surface: ${key.surface}) was ACCEPTED and did not reach its ` +
        `${key.surface} destination — accepted-and-dropped is the defect this guards`,
    ).toBe(true);
  });
});
