import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const NPMJS = "https://registry.npmjs.org";

const DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];

export function tarballUrl(name, version, registry = NPMJS) {
  const base = name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name;
  return `${registry}/${name}/-/${base}-${version}.tgz`;
}

export function versionUrl(name, version, registry = NPMJS) {
  return `${registry}/${name}/${version}`;
}

export function packumentUrl(name, registry = NPMJS) {
  return `${registry}/${name.replace("/", "%2f")}`;
}

export function integrityOf(buffer) {
  return `sha512-${createHash("sha512").update(buffer).digest("base64")}`;
}

export function registryHost(url) {
  const host = url
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  if (!host || /[\s/]/.test(host)) throw new Error("the registry must be a bare https host");
  return host;
}

export function npmrcFor({ host, token, scope }) {
  const url = `https://${host}/`;
  const lines = [];
  if (scope) lines.push(`${scope}:registry=${url}`);
  if (token) lines.push(`//${host}/:_authToken=${token}`);
  return `${lines.join("\n")}\n`;
}

export function alreadyPublished(output) {
  if (/\bE409\b/.test(output) || /\bEPUBLISHCONFLICT\b/.test(output)) return true;
  return /\bE403\b/.test(output) && /cannot publish over|previously published/i.test(output);
}

export function packFilename(stdout) {
  const parsed = JSON.parse(stdout);
  const entry = Array.isArray(parsed)
    ? parsed[0]
    : typeof parsed?.filename === "string"
      ? parsed
      : Object.values(parsed ?? {})[0];
  if (typeof entry?.filename !== "string") {
    throw new Error(`npm pack printed no filename: ${stdout.slice(0, 200)}`);
  }
  return entry.filename;
}

export function publishOrder(manifests) {
  const byName = new Map(manifests.map((m) => [m.name, m]));
  const state = new Map();
  const ordered = [];
  const visit = (name) => {
    if (state.get(name) === "done") return;
    if (state.get(name) === "visiting") throw new Error(`dependency cycle through ${name}`);
    state.set(name, "visiting");
    const manifest = byName.get(name);
    for (const field of DEPENDENCY_FIELDS) {
      for (const dep of Object.keys(manifest[field] ?? {}).sort()) {
        if (byName.has(dep)) visit(dep);
      }
    }
    state.set(name, "done");
    ordered.push(manifest);
  };
  for (const name of [...byName.keys()].sort()) visit(name);
  return ordered;
}

export function readTarballManifest(file) {
  const text = execFileSync("tar", ["-xOzf", file, "package/package.json"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(text);
}

export function describeTarball(file) {
  const manifest = readTarballManifest(file);
  return {
    name: manifest.name,
    version: manifest.version,
    file: path.resolve(file),
    integrity: integrityOf(fs.readFileSync(file)),
    manifest,
  };
}

export function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(full, base);
    return [path.relative(base, full).split(path.sep).join("/")];
  });
}

export function extractTarball(file, into) {
  fs.mkdirSync(into, { recursive: true });
  execFileSync("tar", ["-xzf", file, "-C", into, "--strip-components=1"]);
  return into;
}

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

function sameManifest(a, b) {
  try {
    const parse = (file) => JSON.stringify(canonical(JSON.parse(fs.readFileSync(file, "utf8"))));
    return parse(a) === parse(b);
  } catch {
    return false;
  }
}

export function treeDifferences(a, b) {
  const aFiles = new Set(listFiles(a));
  const bFiles = new Set(listFiles(b));
  const differences = [];
  for (const file of new Set([...aFiles, ...bFiles])) {
    if (!aFiles.has(file)) differences.push(`- ${file}`);
    else if (!bFiles.has(file)) differences.push(`+ ${file}`);
    else if (file === "package.json") {
      if (!sameManifest(path.join(a, file), path.join(b, file))) differences.push(`~ ${file}`);
    } else if (!fs.readFileSync(path.join(a, file)).equals(fs.readFileSync(path.join(b, file)))) {
      differences.push(`~ ${file}`);
    }
  }
  return differences.sort();
}

export function tarballDifferences(local, published) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "tarball-diff-"));
  try {
    return treeDifferences(
      extractTarball(local, path.join(work, "local")),
      extractTarball(published, path.join(work, "published")),
    );
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

export function npm(args, options = {}) {
  const result = spawnSync("npm", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === "win32",
    ...options,
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function request(url, init = {}, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { redirect: "follow", ...init });
      if (response.status < 500) return response;
      lastError = new Error(`${url} answered ${response.status}`);
      await response.body?.cancel();
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) await sleep(1000 * attempt);
  }
  throw lastError;
}

export async function latestManifest(name, registry = NPMJS) {
  const response = await request(versionUrl(name, "latest", registry), {
    headers: { accept: "application/json" },
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) throw new Error(`${name}@latest: the registry answered ${response.status}`);
  return response.json();
}

export async function versionState(name, version, registry = NPMJS) {
  const response = await request(versionUrl(name, version, registry), {
    headers: { accept: "application/json" },
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return { published: false, integrity: null };
  }
  if (!response.ok) throw new Error(`${name}@${version}: the registry answered ${response.status}`);
  const doc = await response.json();
  return { published: true, integrity: doc?.dist?.integrity ?? null };
}

export async function publishedDifferences(tarball, live, registry = NPMJS) {
  if (live.integrity && live.integrity === tarball.integrity) return [];
  const spec = `${tarball.name}@${tarball.version}`;
  const response = await request(tarballUrl(tarball.name, tarball.version, registry));
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${spec}: npmjs lists it but serves no tarball yet (${response.status})`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (live.integrity && integrityOf(bytes) !== live.integrity) {
    throw new Error(`${spec}: npmjs serves ${integrityOf(bytes)}, not its own ${live.integrity}`);
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "published-"));
  try {
    const file = path.join(work, "published.tgz");
    fs.writeFileSync(file, bytes);
    return tarballDifferences(tarball.file, file);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

export async function readiness({ name, version, integrity, tag }, registry = NPMJS) {
  const missing = [];
  const tarball = await request(tarballUrl(name, version, registry));
  if (tarball.ok) {
    const bytes = Buffer.from(await tarball.arrayBuffer());
    const live = integrityOf(bytes);
    if (integrity && live !== integrity) {
      return {
        ready: false,
        fatal: `the tarball on the registry is ${live}, expected ${integrity}`,
      };
    }
  } else {
    await tarball.body?.cancel();
    missing.push(`tarball ${tarball.status}`);
  }
  const doc = await request(versionUrl(name, version, registry), {
    headers: { accept: "application/json" },
  });
  await doc.body?.cancel();
  if (!doc.ok) missing.push(`version document ${doc.status}`);
  const packument = await request(packumentUrl(name, registry), {
    headers: { accept: "application/vnd.npm.install-v1+json" },
  });
  if (packument.ok) {
    const body = await packument.json();
    if (!body?.versions?.[version]) missing.push("not in the version list yet");
    if (tag && body?.["dist-tags"]?.[tag] !== version) {
      missing.push(`dist-tag ${tag} is ${body?.["dist-tags"]?.[tag] ?? "unset"}`);
    }
  } else {
    await packument.body?.cancel();
    missing.push(`packument ${packument.status}`);
  }
  return { ready: missing.length === 0, missing };
}

export async function waitUntilServed(entries, options = {}) {
  const {
    deadlineMs = 45 * 60 * 1000,
    intervalMs = 30 * 1000,
    registry = NPMJS,
    log = console.log,
    now = Date.now,
    wait = sleep,
  } = options;
  const started = now();
  const pending = new Map(entries.map((entry) => [`${entry.name}@${entry.version}`, entry]));
  for (let round = 1; ; round++) {
    for (const [key, entry] of [...pending]) {
      const state = await readiness(entry, registry);
      if (state.fatal) throw new Error(`${key}: ${state.fatal}`);
      if (state.ready) {
        log(`served: ${key} after ${Math.round((now() - started) / 1000)}s`);
        pending.delete(key);
      } else if (round === 1 || round % 10 === 0) {
        log(`waiting: ${key} (${state.missing.join(", ")})`);
      }
    }
    if (pending.size === 0) return;
    const elapsed = now() - started;
    if (elapsed >= deadlineMs) {
      throw new Error(
        `still not served after ${Number((deadlineMs / 60000).toFixed(1))} min: ${[...pending.keys()].join(", ")}`,
      );
    }
    await wait(Math.min(intervalMs, deadlineMs - elapsed));
  }
}

export function appendFile(variable, text) {
  const file = process.env[variable];
  if (file) fs.appendFileSync(file, text);
}
