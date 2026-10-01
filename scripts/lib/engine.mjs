import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonical, extractTarball, listFiles } from "./registry.mjs";

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

export function approvedRcOf(rc, version) {
  const value = String(rc ?? "");
  if (!/^\d+\.\d+\.\d+-rc\.\d+$/.test(value) || !value.startsWith(`${version}-rc.`)) {
    throw new Error(`the approved RC '${value}' is not a release candidate of ${version}`);
  }
  return value;
}

const RESTAMPED = ["dependencies", "optionalDependencies", "peerDependencies"];

export function restamped(manifest, version) {
  const out = structuredClone(manifest);
  out.version = version;
  for (const field of RESTAMPED) {
    for (const dep of Object.keys(out[field] ?? {})) {
      if (dep === "afterpack" || dep.startsWith("@afterpack/")) out[field][dep] = version;
    }
  }
  out.repository = { type: "git", url: EXPECTED_REPOSITORY };
  return out;
}

export function restampDifferences(rcDir, stableDir, version) {
  const rcFiles = new Set(listFiles(rcDir));
  const stableFiles = new Set(listFiles(stableDir));
  const differences = [];
  for (const file of [...new Set([...rcFiles, ...stableFiles])].sort()) {
    if (!rcFiles.has(file)) differences.push(`+ ${file}`);
    else if (!stableFiles.has(file)) differences.push(`- ${file}`);
    else if (file === "package.json") {
      const read = (dir) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      const want = JSON.stringify(canonical(restamped(read(rcDir), version)));
      if (JSON.stringify(canonical(read(stableDir))) !== want) {
        differences.push("~ package.json (beyond the version restamp)");
      }
    } else if (
      !fs.readFileSync(path.join(rcDir, file)).equals(fs.readFileSync(path.join(stableDir, file)))
    ) {
      differences.push(`~ ${file}`);
    }
  }
  return differences;
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

export function tarballRestampDifferences(rcFile, stableFile, version) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "restamp-"));
  try {
    return restampDifferences(
      extractTarball(rcFile, path.join(work, "rc")),
      extractTarball(stableFile, path.join(work, "stable")),
      version,
    );
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
