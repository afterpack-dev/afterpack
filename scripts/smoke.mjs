import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BINDINGS, bindingPackage, CORE, SEMVER } from "./lib/engine.mjs";
import { appendFile, npm, npmrcFor, registryHost, sleep } from "./lib/registry.mjs";
import {
  compareManifests,
  hostIsMusl,
  isInside,
  listFixtures,
  loadedAddons,
  notServedYet,
  PRESETS,
  readFixture,
  resultKey,
  runNode,
  SEEDS,
  sha256,
} from "./lib/smoke.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURES = path.join(ROOT, "scripts", "smoke-fixtures");

function fail(message) {
  throw new Error(message);
}

function flag(args, name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function scratchProject(label) {
  const base = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), `${label}-`));
  const project = path.join(base, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(
    path.join(project, "package.json"),
    `${JSON.stringify({ name: label, private: true }, null, 2)}\n`,
  );
  return { base, project };
}

async function withScratch(label, fn) {
  const scratch = scratchProject(label);
  try {
    return await fn(scratch);
  } finally {
    fs.rmSync(scratch.base, { recursive: true, force: true });
  }
}

async function install(project, spec, npmrcText, { patienceMs = 0 } = {}) {
  const npmrc = path.join(path.dirname(project), "npmrc");
  fs.writeFileSync(npmrc, npmrcText, { mode: 0o600 });
  const deadline = Date.now() + patienceMs;
  try {
    for (;;) {
      const result = npm(
        ["install", spec, "--no-audit", "--no-fund", "--ignore-scripts", "--prefer-online"],
        { cwd: project, env: { ...process.env, NPM_CONFIG_USERCONFIG: npmrc } },
      );
      if (result.status === 0) return;
      if (Date.now() >= deadline || !notServedYet(result.stderr)) {
        fail(`npm install ${spec} failed:\n${result.stderr.slice(-4000)}`);
      }
      console.log(`npm does not serve ${spec} to this runner yet; trying again in 30 s`);
      await sleep(30 * 1000);
    }
  } finally {
    fs.rmSync(npmrc, { force: true });
  }
}

function sourceRegistryNpmrc() {
  const registry = process.env.ENGINE_REGISTRY;
  if (!registry) return "";
  const token = process.env.ENGINE_REGISTRY_TOKEN;
  if (!token) fail("ENGINE_REGISTRY is set without ENGINE_REGISTRY_TOKEN");
  const host = registryHost(registry);
  if (process.env.GITHUB_ACTIONS === "true") console.log(`::add-mask::${host}`);
  return npmrcFor({ host, token, scope: "@afterpack" });
}

async function engine(args) {
  const version = flag(args, "version") ?? "";
  const binding = flag(args, "binding") ?? "";
  if (!SEMVER.test(version)) fail(`'${version}' is not a version`);
  const want = BINDINGS[binding] ?? fail(`unknown binding '${binding}'`);
  const host = { platform: process.platform, arch: process.arch, musl: hostIsMusl() };
  if (host.platform !== want.platform || host.arch !== want.arch || host.musl !== want.musl) {
    fail(`this runner is ${JSON.stringify(host)}, not the ${binding} binding's host`);
  }
  const { manifest, problems } = await withScratch("engine-smoke", async ({ base, project }) => {
    console.log(`installing ${CORE}@${version} for ${binding} on node ${process.version}`);
    await install(project, `${CORE}@${version}`, sourceRegistryNpmrc());

    delete process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
    delete process.env.NAPI_RS_FORCE_WASI;
    const require = createRequire(path.join(project, "package.json"));
    const bindingDir = path.dirname(require.resolve(`${bindingPackage(binding)}/package.json`));
    const bindingVersion = JSON.parse(
      fs.readFileSync(path.join(bindingDir, "package.json"), "utf8"),
    ).version;
    if (bindingVersion !== version) {
      fail(`${bindingPackage(binding)} is ${bindingVersion}, expected ${version}`);
    }
    const core = require(CORE);
    const addons = loadedAddons(require.cache);
    if (addons.length !== 1 || !isInside(addons[0], bindingDir)) {
      fail(`expected the native ${binding} binding, loaded: ${addons.join(", ") || "none"}`);
    }
    const reported = await core.version();
    if (reported !== version) fail(`version() is ${reported}, expected ${version}`);
    console.log(`native binding ${path.basename(addons[0])}, version() ${reported}`);

    const runs = path.join(base, "runs");
    fs.mkdirSync(runs);
    const manifest = { inputs: {}, results: {} };
    const problems = [];
    for (const fixture of listFixtures(FIXTURES)) {
      const source = readFixture(FIXTURES, fixture);
      manifest.inputs[fixture] = sha256(source);
      const original = path.join(runs, `original-${fixture}`);
      fs.writeFileSync(original, source);
      const expected = runNode([original], runs);
      if (expected.status !== 0) fail(`${fixture} fails before obfuscation:\n${expected.stderr}`);
      for (const preset of PRESETS) {
        for (const seed of SEEDS) {
          const key = resultKey(fixture, preset, seed);
          const batch = await core.processBatch([{ path: fixture, source }], { preset, seed });
          const file = batch.files[0];
          if (file.status !== "success" || file.unobfuscated || !file.code) {
            problems.push(`${key}: ${file.status} ${file.error ?? "no protected output"}`);
            continue;
          }
          manifest.results[key] = sha256(file.code);
          const protectedFile = path.join(runs, `${preset}-${seed}-${fixture}`);
          fs.writeFileSync(protectedFile, file.code);
          const got = runNode([protectedFile], runs);
          if (got.status !== 0 || got.stdout !== expected.stdout) {
            problems.push(`${key}: the protected program ran differently (exit ${got.status})`);
          }
        }
      }
    }
    return { manifest, problems };
  });
  const count = Object.keys(manifest.results).length;
  console.log(`${count} protected outputs executed`);

  const golden = process.env.RC_SMOKE_GOLDEN;
  if (golden) {
    const differences = compareManifests(JSON.parse(golden), manifest);
    for (const line of differences) problems.push(`differs from the golden run: ${line}`);
    if (differences.length === 0) console.log(`all ${count} output hashes match the golden run`);
  }
  appendFile("GITHUB_OUTPUT", `manifest=${JSON.stringify(manifest)}\n`);
  appendFile(
    "GITHUB_STEP_SUMMARY",
    `${problems.length ? "FAILED" : "OK"} \`${binding}\` on node ${process.version}: \`${CORE}@${version}\` loaded its native binding, ${count} protected outputs ran${golden ? ", hashes compared with the golden run" : ""}.\n`,
  );
  if (problems.length > 0) {
    for (const line of problems) console.error(line);
    fail(`${problems.length} problem(s) on ${binding}`);
  }
}

function binPath(require, name) {
  const manifestPath = require.resolve(`${name}/package.json`);
  const { bin } = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const relative = typeof bin === "string" ? bin : bin?.[name];
  if (!relative) fail(`${name} declares no ${name} bin`);
  return path.join(path.dirname(manifestPath), relative);
}

function cli(bin, args, cwd) {
  const result = runNode([bin, ...args], cwd);
  if (result.status !== 0) {
    fail(`afterpack ${args.join(" ")} exited ${result.status}:\n${result.stderr.slice(-4000)}`);
  }
  return result.stdout;
}

async function release(args) {
  const version = flag(args, "version") ?? "";
  if (!SEMVER.test(version)) fail(`'${version}' is not a version`);
  const count = await withScratch("release-verify", async ({ project }) => {
    console.log(`installing afterpack@${version} from npmjs on node ${process.version}`);
    await install(project, `afterpack@${version}`, "", { patienceMs: 10 * 60 * 1000 });
    const require = createRequire(path.join(project, "package.json"));
    const bin = binPath(require, "afterpack");
    const reported = cli(bin, ["--version"], project).trim();
    if (reported !== version) fail(`afterpack --version is ${reported}, expected ${version}`);

    const dist = path.join(project, "dist");
    fs.mkdirSync(dist);
    const expected = {};
    for (const fixture of listFixtures(FIXTURES)) {
      const file = path.join(dist, fixture);
      fs.writeFileSync(file, readFixture(FIXTURES, fixture));
      const run = runNode([file], dist);
      if (run.status !== 0) fail(`${fixture} fails before obfuscation:\n${run.stderr}`);
      expected[fixture] = { source: fs.readFileSync(file, "utf8"), stdout: run.stdout };
    }
    cli(bin, ["dist", "--protectionMap.enabled=false", "--telemetry.enabled=false"], project);
    const receipt = JSON.parse(
      fs.readFileSync(path.join(dist, ".afterpack-protection.json"), "utf8"),
    );
    if (receipt.engine !== "local") fail(`the receipt records engine '${receipt.engine}'`);
    for (const [fixture, want] of Object.entries(expected)) {
      const file = path.join(dist, fixture);
      if (fs.readFileSync(file, "utf8") === want.source) fail(`${fixture} was not obfuscated`);
      const run = runNode([file], dist);
      if (run.status !== 0 || run.stdout !== want.stdout) {
        fail(`${fixture} runs differently after obfuscation (exit ${run.status}):\n${run.stderr}`);
      }
    }
    return Object.keys(expected).length;
  });
  console.log(`afterpack@${version} obfuscated ${count} files that still run the same`);
  appendFile(
    "GITHUB_STEP_SUMMARY",
    `OK \`${process.platform}-${process.arch}\` on node ${process.version}: \`afterpack@${version}\` from npmjs obfuscated ${count} programs that still run the same.\n`,
  );
}

const COMMANDS = { engine, release };
const [command, ...args] = process.argv.slice(2);
try {
  if (!COMMANDS[command]) {
    fail(
      "usage: node scripts/smoke.mjs engine --version <v> --binding <abi> | release --version <v>",
    );
  }
  await COMMANDS[command](args);
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exitCode = 1;
}
