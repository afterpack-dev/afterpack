import { pathBundleLabel, qualifiedBundleLabel } from "@afterpack/integration-utils";

interface ViteBundleSource {
  configFile: string | undefined;
  root: string;
  framework: string | undefined;
  environment: string;
  leg: string | undefined;
}

export function viteBundleLabel(source: ViteBundleSource): string | undefined {
  if (source.configFile) {
    const nonClient = source.environment === "client" ? undefined : source.environment;
    return qualifiedBundleLabel(
      pathBundleLabel(source.configFile, source.root),
      source.leg ?? nonClient,
    );
  }
  return qualifiedBundleLabel(source.framework ?? "vite", source.leg ?? source.environment);
}
