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

export function resolveEngineRelease({ event, payload, inputVersion }) {
  const fromDispatch = event === "repository_dispatch";
  const version = String((fromDispatch ? payload?.version : inputVersion) ?? "").replace(/^v/, "");
  if (!STABLE.test(version)) throw new Error(`'${version}' is not a stable version`);
  return { version, fromDispatch };
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

export const SOURCE_SHA = /^[0-9a-f]{40}$/;

export function releaseOf(version) {
  return version.replace(/[-+].*$/, "");
}

export function servedEngineProblems(info, { version, sha }) {
  if (!SEMVER.test(version)) return [`'${version}' is not a version`];
  if (!SOURCE_SHA.test(sha)) return [`'${sha}' is not a 40-character commit sha`];
  if (info === null || typeof info !== "object") return ["the API answered no version document"];
  const problems = [];
  if (info.engineSourceSha !== sha) {
    problems.push(
      `the API serves the engine built from ${info.engineSourceSha ?? "an unknown commit"}, not the candidate's ${sha}`,
    );
  }
  if (info.engineSourceDirty !== false) {
    problems.push("the API does not report its engine as built from a clean tree");
  }
  if (info.engineVersion !== releaseOf(version)) {
    problems.push(
      `the API's engine is version ${info.engineVersion ?? "(none)"}, not ${releaseOf(version)}`,
    );
  }
  return problems;
}
