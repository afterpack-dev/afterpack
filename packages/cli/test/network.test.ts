import { createPrivateKey, createPublicKey, diffieHellman } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { engineCalls, processBatch } from "../../../test/core-fake.js";
import { stripAnsi } from "../src/format.js";
import { generateNetworkKeyPair } from "../src/network.js";
import { run } from "../src/run.js";

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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "afterpack-network-"));
  out = [];
  err = [];
  engineCalls.length = 0;
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

describe("afterpack network: usage", () => {
  it("answers --help with its own page", async () => {
    expect(await invoke(["network", "--help"])).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("usage: afterpack network keygen");
    expect(text).toContain("arrives in a later release");
  });

  it("refuses a missing or unknown command and extra arguments with 64", async () => {
    expect(await invoke(["network"])).toBe(64);
    expect(await invoke(["network", "rotate"])).toBe(64);
    expect(await invoke(["network", "init"])).toBe(64);
    expect(await invoke(["network", "keygen", "extra"])).toBe(64);
    expect(await invoke(["network", "keygen", "--preset=fast"])).toBe(64);
  });

  it("is listed in the short help", async () => {
    expect(await invoke(["--help"])).toBe(0);
    expect(out.join("\n")).toContain("afterpack network keygen");
  });
});
