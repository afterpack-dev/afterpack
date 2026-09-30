export const BINDINGS = {
  "darwin-arm64": { platform: "darwin", arch: "arm64", musl: false },
  "darwin-x64": { platform: "darwin", arch: "x64", musl: false },
  "linux-x64-gnu": { platform: "linux", arch: "x64", musl: false },
  "linux-arm64-gnu": { platform: "linux", arch: "arm64", musl: false },
  "linux-x64-musl": { platform: "linux", arch: "x64", musl: true },
  "linux-arm64-musl": { platform: "linux", arch: "arm64", musl: true },
  "win32-x64-msvc": { platform: "win32", arch: "x64", musl: false },
};

export const CORE = "@afterpack/core";

export const bindingPackage = (abi) => `${CORE}-${abi}`;

export const ENGINE_PACKAGES = [
  ...Object.keys(BINDINGS).map(bindingPackage),
  "@afterpack/wasm",
  CORE,
];

export const EXPECTED_REPOSITORY = "git+https://github.com/afterpack-dev/afterpack.git";

export const STABLE = /^\d+\.\d+\.\d+$/;

export const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function hostBinding({ platform, arch, musl }) {
  const match = Object.entries(BINDINGS).find(
    ([, b]) => b.platform === platform && b.arch === arch && b.musl === Boolean(musl),
  );
  return match ? match[0] : null;
}

export function resolveEngineRelease({ event, payload, inputVersion, inputTag }) {
  const fromDispatch = event === "repository_dispatch";
  const version = String((fromDispatch ? payload?.version : inputVersion) ?? "").replace(/^v/, "");
  const tag = (fromDispatch ? payload?.tag : inputTag) || "latest";
  if (!STABLE.test(version)) throw new Error(`'${version}' is not a stable version`);
  if (tag !== "latest" && tag !== "rc") throw new Error(`dist-tag '${tag}' is not latest or rc`);
  return { version, tag, fromDispatch };
}

export function payloadIntegrity(payload, name) {
  const entry = (payload?.packages ?? []).find((p) => p?.name === name);
  return typeof entry?.integrity === "string" && entry.integrity ? entry.integrity : null;
}

export function checkEngineManifest(manifest, name, version) {
  const problems = [];
  if (manifest.name !== name || manifest.version !== version) {
    problems.push(`is ${manifest.name}@${manifest.version}, expected ${name}@${version}`);
  }
  const repository = manifest.repository?.url ?? "";
  if (repository !== EXPECTED_REPOSITORY) {
    problems.push(`repository.url is '${repository}', expected '${EXPECTED_REPOSITORY}'`);
  }
  return problems;
}
