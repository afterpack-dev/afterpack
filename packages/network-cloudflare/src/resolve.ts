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

const HEXTET = /^[0-9a-f]{1,4}$/;

function ipv6Groups(address: string): string[] | null {
  const halves = address.toLowerCase().split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : halves[0].split(":");
  const tail = halves.length === 2 && halves[1] !== "" ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const groups = [...head, ...new Array<string>(fill).fill("0"), ...tail];
  return groups.every((group) => HEXTET.test(group)) ? groups : null;
}

function addressKey(address: string): string {
  if (!address.includes(":") || address.includes(".")) return address;
  const groups = ipv6Groups(address.split("%")[0]);
  if (groups === null) return address;
  const prefix = groups.slice(0, 4).map((group) => Number.parseInt(group, 16).toString(16));
  return `${prefix.join(":")}::/64`;
}

export function cloudflareClientAddress(request: Request): string | null {
  const address = request.headers.get("cf-connecting-ip");
  return address === null ? null : addressKey(address.trim());
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
