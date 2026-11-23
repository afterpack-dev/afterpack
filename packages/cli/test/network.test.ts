import { createPrivateKey, createPublicKey, diffieHellman } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfigFile } from "@afterpack/integration-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { engineCalls, processBatch } from "../../../test/core-fake.js";
import { CONFIG_BY_PATH } from "../../integration-utils/src/registry.js";
import { stripAnsi } from "../src/format.js";
import { generateNetworkKeyPair, SECRET_NAME, serverSnippet } from "../src/network.js";
import { run } from "../src/run.js";

const registry = vi.hoisted(() => ({ acceptsNetwork: false }));

vi.mock("@afterpack/integration-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@afterpack/integration-utils")>();
  return {
    ...actual,
    validateConfig: (input: unknown, surface: string) => {
      const result = actual.validateConfig(input, surface);
      if (!registry.acceptsNetwork) return result;
      return {
        ...result,
        issues: result.issues.filter((issue) => !issue.path.startsWith("network")),
      };
    },
  };
});

let root: string;
let out: string[];
let err: string[];

const logger = {
  log: (m: string) => out.push(m),
  error: (m: string) => err.push(m),
  warn: () => {},
};

function invoke(argv: string[], cwd = root): Promise<number> {
  return run({
    argv,
    cwd,
    engine: { processBatch },
    logger,
    version: "9.9.9",
    env: {},
    stdout: { isTTY: false, write: () => {} },
  });
}

const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;

function keyObjects(publicKey: string, privateKey: string) {
  return {
    pub: createPublicKey({ key: { kty: "OKP", crv: "X25519", x: publicKey }, format: "jwk" }),
    priv: createPrivateKey({
      key: { kty: "OKP", crv: "X25519", x: publicKey, d: privateKey },
      format: "jwk",
    }),
  };
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, "afterpack.json"), "utf8"));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "afterpack-network-"));
  out = [];
  err = [];
  engineCalls.length = 0;
  registry.acceptsNetwork = true;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("afterpack network keygen", () => {
  it("prints a matching X25519 pair in base64url, 32 bytes each, and writes nothing", async () => {
    expect(await invoke(["network", "keygen"])).toBe(0);
    const text = stripAnsi(out.join("\n"));
    const publicKey = /publicKey\s+(\S+)/.exec(text)?.[1] ?? "";
    const privateKey = /privateKey\s+(\S+)/.exec(text)?.[1] ?? "";
    expect(publicKey).toMatch(B64URL_32);
    expect(privateKey).toMatch(B64URL_32);
    expect(Buffer.from(publicKey, "base64url")).toHaveLength(32);
    const { pub, priv } = keyObjects(publicKey, privateKey);
    const peer = generateNetworkKeyPair();
    const other = keyObjects(peer.publicKey, peer.privateKey);
    expect(diffieHellman({ privateKey: priv, publicKey: other.pub })).toEqual(
      diffieHellman({ privateKey: other.priv, publicKey: pub }),
    );
    expect(existsSync(join(root, "afterpack.json"))).toBe(false);
    expect(engineCalls).toHaveLength(0);
  });

  it("never prints the same pair twice", () => {
    const pairs = new Set(Array.from({ length: 20 }, () => generateNetworkKeyPair().privateKey));
    expect(pairs.size).toBe(20);
  });

  it("prints one JSON document with --diagnostics.format=json", async () => {
    expect(await invoke(["network", "keygen", "--diagnostics.format=json"])).toBe(0);
    const doc = JSON.parse(out.join("\n"));
    expect(doc).toMatchObject({ command: "network", ok: true, exitCode: 0 });
    expect(doc.summary.publicKey).toMatch(B64URL_32);
    expect(doc.summary.privateKey).toMatch(B64URL_32);
  });
});

describe("afterpack network init: against the real config registry", () => {
  beforeEach(() => {
    registry.acceptsNetwork = false;
  });

  it("leaves an afterpack.json that loads with no issue", async () => {
    expect(await invoke(["network", "init"])).toBe(0);
    expect(loadConfigFile(root).issues).toEqual([]);
    const known = CONFIG_BY_PATH.has("network.publicKey");
    expect(existsSync(join(root, "afterpack.json"))).toBe(known);
    if (known) return;
    const text = stripAnsi(out.join("\n"));
    expect(text).toContain("init wrote nothing");
    expect(text).toMatch(/"publicKey": "[A-Za-z0-9_-]{43}"/);
    expect(text).toContain('import { createNetworkProtection } from "@afterpack/network-core";');
  });

  it("keeps an existing afterpack.json loadable, and byte for byte until it accepts network", async () => {
    if (CONFIG_BY_PATH.has("network.publicKey")) return;
    const before = `${JSON.stringify({ preset: "medium" }, null, 2)}\n`;
    writeFileSync(join(root, "afterpack.json"), before);
    expect(loadConfigFile(root).issues).toEqual([]);
    expect(await invoke(["network", "init", "--diagnostics.format=json"])).toBe(0);
    expect(readFileSync(join(root, "afterpack.json"), "utf8")).toBe(before);
    expect(loadConfigFile(root).issues).toEqual([]);
    const doc = JSON.parse(out.join("\n"));
    expect(doc.summary.configWritten).toBe(false);
    expect(doc.summary.network.publicKey).toBe(doc.summary.publicKey);
    expect(doc.summary.network.routes).toEqual({ include: ["/api/**"] });
    expect(doc.artifacts).toEqual({});
  });
});

describe("afterpack network init: once the config accepts network", () => {
  it("detects Cloudflare from wrangler.toml, writes the public key and prints the snippet and secret line", async () => {
    writeFileSync(join(root, "wrangler.toml"), 'name = "app"\n');
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { hono: "4.0.0" } }));
    writeFileSync(join(root, "pnpm-lock.yaml"), "");
    expect(await invoke(["network", "init"])).toBe(0);
    const network = readConfig().network as { publicKey: string; routes: { include: string[] } };
    expect(network.publicKey).toMatch(B64URL_32);
    expect(network.routes.include).toEqual(["/api/**"]);
    const text = stripAnsi(out.join("\n"));
    expect(text).toContain("Cloudflare (wrangler.toml)");
    expect(text).toContain(`$ npx wrangler secret put ${SECRET_NAME}`);
    expect(text).toContain("$ pnpm add @afterpack/network-cloudflare");
    expect(text).toContain('import { networkProtection } from "@afterpack/network-cloudflare";');
    expect(text).toContain('"/api/*",');
    expect(text).toContain(`privateKeys: env.${SECRET_NAME},`);
    expect(text).toContain("Edge WAF rules and rate limits keyed on an API path");
    const privateKey = /Private key[^\n]*\n\s+(\S+)/.exec(text)?.[1] ?? "";
    expect(privateKey).toMatch(B64URL_32);
    const { pub } = keyObjects(network.publicKey, privateKey);
    expect(pub.export({ format: "jwk" }).x).toBe(network.publicKey);
    expect(
      createPublicKey(keyObjects(network.publicKey, privateKey).priv).export({ format: "jwk" }).x,
    ).toBe(network.publicKey);
  });

  it("detects Cloudflare from wrangler.jsonc and prints the Worker wrapper without Hono", async () => {
    writeFileSync(join(root, "wrangler.jsonc"), "{}\n");
    expect(await invoke(["network", "init"])).toBe(0);
    const text = stripAnsi(out.join("\n"));
    expect(text).toContain("Cloudflare (wrangler.jsonc)");
    expect(text).toContain("export default withNetworkProtection(worker, (env) => ({");
    expect(text).toContain("$ npm install @afterpack/network-cloudflare");
  });

  it("prints the fetch-style snippet and no wrangler line when no Cloudflare config is found", async () => {
    expect(await invoke(["network", "init"])).toBe(0);
    const text = stripAnsi(out.join("\n"));
    expect(text).toContain('import { createNetworkProtection } from "@afterpack/network-core";');
    expect(text).not.toContain("wrangler");
  });

  it("keeps the rest of an existing afterpack.json and its routes", async () => {
    mkdirSync(join(root, "app"));
    writeFileSync(
      join(root, "afterpack.json"),
      JSON.stringify({
        preset: "balanced",
        network: { routes: { include: ["/v1/**"], exclude: ["/v1/feed"] } },
      }),
    );
    expect(await invoke(["network", "init"], join(root, "app"))).toBe(0);
    const config = readConfig();
    expect(config.preset).toBe("balanced");
    expect(config.network).toMatchObject({
      routes: { include: ["/v1/**"], exclude: ["/v1/feed"] },
    });
    expect(existsSync(join(root, "app", "afterpack.json"))).toBe(false);
    expect(stripAnsi(out.join("\n"))).toContain('routes: { include: ["/v1/**"] }');
  });

  it("refuses to replace a public key, and leaves the file untouched", async () => {
    const before = JSON.stringify({
      network: { publicKey: "existing", routes: { include: ["/api/**"] } },
    });
    writeFileSync(join(root, "afterpack.json"), before);
    expect(await invoke(["network", "init"])).toBe(1);
    expect(readFileSync(join(root, "afterpack.json"), "utf8")).toBe(before);
    expect(stripAnsi(err.join("\n"))).toContain("already holds network.publicKey");
    expect(stripAnsi(err.join("\n"))).toContain("afterpack network keygen");
  });

  it("refuses an afterpack.json that is not a JSON object", async () => {
    writeFileSync(join(root, "afterpack.json"), "{ nope");
    expect(await invoke(["network", "init"])).toBe(1);
    writeFileSync(join(root, "afterpack.json"), "[]");
    expect(await invoke(["network", "init"])).toBe(1);
    expect(readFileSync(join(root, "afterpack.json"), "utf8")).toBe("[]");
  });

  it("prints one JSON document with --diagnostics.format=json", async () => {
    writeFileSync(join(root, "wrangler.toml"), "");
    expect(await invoke(["network", "init", "--diagnostics.format=json"])).toBe(0);
    const doc = JSON.parse(out.join("\n"));
    expect(doc.summary).toMatchObject({
      platform: "cloudflare",
      detectedFrom: "wrangler.toml",
      secretName: SECRET_NAME,
      secretCommand: `npx wrangler secret put ${SECRET_NAME}`,
      routes: ["/api/**"],
    });
    expect(doc.summary.publicKey).toBe((readConfig().network as { publicKey: string }).publicKey);
    expect(doc.summary.configWritten).toBe(true);
    expect(doc.artifacts).toEqual({ config: "afterpack.json" });
  });

  it("never runs wrangler or any other process", () => {
    const source = readFileSync(new URL("../src/network.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/child_process|\bspawn\b|\bexec(?:File)?(?:Sync)?\(/);
  });
});

describe("afterpack network: usage", () => {
  it("answers --help with its own page", async () => {
    expect(await invoke(["network", "--help"])).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("usage: afterpack network keygen");
    expect(text).toContain("edge WAF rules and rate limits");
  });

  it("refuses a missing or unknown command and extra arguments with 64", async () => {
    expect(await invoke(["network"])).toBe(64);
    expect(await invoke(["network", "rotate"])).toBe(64);
    expect(await invoke(["network", "keygen", "extra"])).toBe(64);
    expect(await invoke(["network", "keygen", "--preset=fast"])).toBe(64);
  });

  it("is listed in the short help", async () => {
    expect(await invoke(["--help"])).toBe(0);
    expect(out.join("\n")).toContain("afterpack network keygen|init");
  });
});

describe("serverSnippet", () => {
  it("mounts Hono on the one include prefix, and on every path for several", () => {
    expect(serverSnippet("cloudflare", true, ["/v2/**"])).toContain('"/v2/*",');
    expect(serverSnippet("cloudflare", true, ["/graphql"])).toContain('"*",');
    expect(serverSnippet("cloudflare", true, ["/api/*/v1/**"])).toContain('"*",');
    const several = serverSnippet("cloudflare", true, ["/api/**", "/rpc/**"]);
    expect(several).toContain('"*",');
    expect(several).not.toContain('"/api/*",');
    expect(several).toContain('routes: { include: ["/api/**", "/rpc/**"] }');
  });

  it("names every wrangler file it detects in the help", async () => {
    for (const file of ["wrangler.toml", "wrangler.jsonc", "wrangler.json"]) {
      const dir = mkdtempSync(join(tmpdir(), "afterpack-network-"));
      writeFileSync(join(dir, file), file === "wrangler.toml" ? "" : "{}");
      out = [];
      expect(await invoke(["network", "init"], dir)).toBe(0);
      expect(stripAnsi(out.join("\n"))).toContain(`Cloudflare (${file})`);
      rmSync(dir, { recursive: true, force: true });
    }
    out = [];
    expect(await invoke(["network", "--help"])).toBe(0);
    const help = out.join("\n").replace(/\s+/g, " ");
    for (const file of ["wrangler.toml", "wrangler.jsonc", "wrangler.json "]) {
      expect(help).toContain(file);
    }
  });
});
