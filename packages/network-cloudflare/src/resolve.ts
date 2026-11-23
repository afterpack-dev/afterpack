import {
  createNetworkProtection as createCoreProtection,
  type NetworkProtection,
  type NetworkProtectionOptions,
} from "@afterpack/network-core";

export type ProtectionSource<Env> =
  | NetworkProtection
  | NetworkProtectionOptions
  | ((env: Env) => NetworkProtection | NetworkProtectionOptions);

function isProtection(value: unknown): value is NetworkProtection {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as NetworkProtection).handle === "function" &&
    typeof (value as NetworkProtection).openSocket === "function"
  );
}

export function cloudflareClientAddress(request: Request): string | null {
  return request.headers.get("cf-connecting-ip");
}

export function createNetworkProtection(options: NetworkProtectionOptions): NetworkProtection {
  return createCoreProtection({
    ...options,
    clientAddress: options.clientAddress ?? cloudflareClientAddress,
  });
}

function build(value: NetworkProtection | NetworkProtectionOptions): NetworkProtection {
  return isProtection(value) ? value : createNetworkProtection(value);
}

export function protectionResolver<Env>(
  source: ProtectionSource<Env>,
): (env: Env) => NetworkProtection {
  if (typeof source !== "function") {
    let built: NetworkProtection | undefined;
    return () => {
      built ??= build(source);
      return built;
    };
  }
  const byEnv = new WeakMap<object, NetworkProtection>();
  let unkeyed: NetworkProtection | undefined;
  return (env) => {
    if (typeof env === "object" && env !== null) {
      let built = byEnv.get(env);
      if (built === undefined) {
        built = build(source(env));
        byEnv.set(env, built);
      }
      return built;
    }
    unkeyed ??= build(source(env));
    return unkeyed;
  };
}
