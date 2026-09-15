import {
  type AfterpackConfig,
  CONFIG_KEYS,
  type ConfigKeyDef,
  EMPTY_CONFIG,
  getPath,
  mergeConfig,
  nest,
  toPluginOptions,
} from "./registry.js";

export { nest };

export interface ConfigSample {
  value: unknown;
  flat?: string;
}

function itemSample(key: ConfigKeyDef): ConfigSample | undefined {
  switch (key.item.kind) {
    case "boolean":
      return { value: true, flat: "true" };
    case "number":
      return { value: 3, flat: "3" };
    case "unbounded":
      return { value: 4, flat: "4" };
    case "string":
      return key.path === "key"
        ? { value: "ap_live_probe", flat: "ap_live_probe" }
        : { value: "abc", flat: "abc" };
    case "enum":
      return { value: key.item.values[0], flat: String(key.item.values[0]) };
    case "seed":
      return { value: 7, flat: "7" };
    case "reserved":
      return { value: "Hls", flat: "Hls" };
    case "region":
      return { value: { start: 0, end: 1 } };
  }
}

export function configSample(key: ConfigKeyDef): ConfigSample | undefined {
  const item = itemSample(key);
  if (!item) return undefined;
  if (key.shape === "scalar") return item;
  return { value: [item.value], flat: item.flat };
}

export function unforwardedBuildKeys(): ConfigKeyDef[] {
  let config = EMPTY_CONFIG;
  const build = CONFIG_KEYS.filter((k) => k.surface === "build") as ConfigKeyDef[];
  for (const key of build) {
    const sample = configSample(key);
    if (sample) config = mergeConfig(config, nest(key.path, sample.value) as AfterpackConfig);
  }
  const artifacts = toPluginOptions(config).artifactOptions as unknown as AfterpackConfig;
  return build.filter((key) => getPath(artifacts, key.path) === undefined);
}
