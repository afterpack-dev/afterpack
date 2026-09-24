import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __reset,
  __setBatchDecorator,
  __setBatchError,
  __setProcessResult,
  asCloudBatch,
  batchCalls,
  cloudErrorMessage,
  napiError,
  processBatch,
  version,
} from "../../../test/core-fake.js";
import { type ClientIdentity, CloudApiError, CoreVersionError } from "./compat.js";
import { type ObfuscationPassOptions, runObfuscationPass } from "./pass.js";
import { PROTECTION_RECEIPT_FILE, type ProtectionReceipt } from "./receipt.js";
import { resetBuildSessions } from "./seed.js";
import type { TelemetryFacts } from "./telemetry.js";

let root: string;
let outDir: string;
let file: string;

const ESC = String.fromCharCode(0x1b);

const IDENTITY: ClientIdentity = {
  packageName: "@afterpack/vite",
  packageVersion: "0.1.4",
  coreVersion: "0.1.2-rc.9",
};

beforeEach(() => {
  resetBuildSessions();
  __reset();
  __setProcessResult((input) => ({ code: `OBF:${input}` }));
  root = mkdtempSync(join(tmpdir(), "afterpack-compat-pass-"));
  outDir = join(root, "dist");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(root, ".gitignore"), "");
  file = join(outDir, "app.js");
  writeFileSync(file, "export const a = 1;");
});
afterEach(() => {
  resetBuildSessions();
  __reset();
  rmSync(root, { recursive: true, force: true });
});

function capture() {
  const warnings: string[] = [];
  const logs: string[] = [];
  return {
    logger: { warn: (m: string) => warnings.push(m), log: (m: string) => logs.push(m) },
    warnings,
    logs,
    all: () => [...warnings, ...logs].join("\n"),
  };
}

function options(extra: Partial<ObfuscationPassOptions> = {}): ObfuscationPassOptions {
  return {
    files: [file],
    engine: { processBatch, version },
    label: "afterpack-test",
    gitignoreDir: root,
    env: {},
    artifactOptions: { git: false },
    combinedProtectionMap: { buildDir: outDir, afterpackDir: join(root, ".afterpack") },
    ...extra,
  };
}

function receipt(): ProtectionReceipt {
  return JSON.parse(readFileSync(join(outDir, PROTECTION_RECEIPT_FILE), "utf8"));
}

describe("the build context carries the client identity", () => {
  it("sends clientVersion (the installed core) and client flat, next to git", async () => {
    await runObfuscationPass(
      options({
        client: IDENTITY,
        artifactOptions: { git: { commitSha: "abcdef1", ref: "main" } },
        logger: capture().logger,
      }),
    );
    expect(JSON.parse(batchCalls[0].buildContextJson ?? "null")).toEqual({
      commitSha: "abcdef1",
      ref: "main",
      clientVersion: "0.1.2-rc.9",
      client: "@afterpack/vite/0.1.4",
    });
  });

  it("omits whatever is unknown, and sends no context at all when nothing is known", async () => {
    await runObfuscationPass(
      options({ client: { ...IDENTITY, coreVersion: null }, logger: capture().logger }),
    );
    expect(JSON.parse(batchCalls[0].buildContextJson ?? "null")).toEqual({
      client: "@afterpack/vite/0.1.4",
    });

    writeFileSync(file, "export const a = 1;");
    rmSync(join(outDir, PROTECTION_RECEIPT_FILE));
    await runObfuscationPass(options({ logger: capture().logger }));
    expect(batchCalls[1].buildContextJson).toBeUndefined();
  });
});

describe("the core floor", () => {
  it("refuses a core below MIN_CORE_VERSION before any engine call", async () => {
    const cap = capture();
    await expect(
      runObfuscationPass(
        options({ client: { ...IDENTITY, coreVersion: "0.0.9" }, logger: cap.logger }),
      ),
    ).rejects.toThrow(CoreVersionError);
    expect(batchCalls).toHaveLength(0);
    expect(readFileSync(file, "utf8")).toBe("export const a = 1;");
  });
});

describe("notices on a successful build", () => {
  it("prints the batch notices sanitized, with a foreign link dropped", async () => {
    __setBatchDecorator((result) => ({
      ...result,
      notices: [
        {
          severity: "warning",
          code: "DEPRECATION",
          message: `${ESC}[31mcore 0.1 support ends soon${ESC}[0m`,
          url: "https://www.afterpack.dev/docs/upgrade",
        },
        { severity: "info", code: "PHISH", message: "log in here", url: "https://evil.test/" },
        { severity: "brand-new", code: "X", message: "future severity" },
      ],
    }));
    const cap = capture();
    await runObfuscationPass(options({ logger: cap.logger }));
    expect(cap.warnings).toContain(
      "[afterpack-test] AfterPack warning: core 0.1 support ends soon https://www.afterpack.dev/docs/upgrade",
    );
    expect(cap.logs).toContain("[afterpack-test] AfterPack notice: log in here");
    expect(cap.warnings).toContain("[afterpack-test] AfterPack warning: future severity");
    expect(cap.all()).not.toContain("evil.test");
    expect(cap.all()).not.toContain(ESC);
    expect(readFileSync(file, "utf8")).toBe("OBF:export const a = 1;");
  });

  it("prints nothing when the batch carries no notices", async () => {
    const cap = capture();
    await runObfuscationPass(options({ logger: cap.logger }));
    expect(cap.all()).not.toContain("AfterPack notice");
    expect(cap.all()).not.toContain("AfterPack warning");
  });
});

describe("the cloud engine version", () => {
  it("is what the receipt and telemetry record on a cloud build", async () => {
    __setBatchDecorator((result) => ({ ...asCloudBatch(result), engineVersion: "0.1.7" }));
    const seen: TelemetryFacts[] = [];
    await runObfuscationPass(
      options({
        logger: capture().logger,
        client: IDENTITY,
        telemetry: async (facts) => {
          if (facts) seen.push(facts);
        },
        artifactOptions: { git: false, telemetry: { enabled: true } },
      }),
    );
    expect(receipt().engine).toBe("cloud");
    expect(receipt().engineVersion).toBe("0.1.7");
    expect(seen[0].engineVersion).toBe("0.1.7");
    expect(seen[0].clientVersion).toBe("0.1.4");
  });

  it("falls back to the local version() when the cloud sends none or a malformed one", async () => {
    __setBatchDecorator((result) => ({
      ...asCloudBatch(result),
      engineVersion: `0.1.7${ESC}[2J`,
    }));
    await runObfuscationPass(options({ logger: capture().logger }));
    expect(receipt().engineVersion).toBe("0.0.0-test");
  });

  it("is ignored on a local build", async () => {
    __setBatchDecorator((result) => ({ ...result, engineVersion: "9.9.9" }));
    await runObfuscationPass(options({ logger: capture().logger }));
    expect(receipt().engineVersion).toBe("0.0.0-test");
  });
});

describe("cloud per-file diagnostics", () => {
  it("are reported, and the refusal names the first blocking CODE: message", async () => {
    __setProcessResult(() => ({
      code: "",
      diagnostics: [
        { severity: "info", code: "DIAG_TARGET_REACHED", message: "fine" },
        { severity: "error", code: "DIAG_PARSE_ERROR", message: "unexpected token" },
      ],
    }));
    __setBatchDecorator((result) => asCloudBatch(result));
    const cap = capture();
    await expect(runObfuscationPass(options({ logger: cap.logger }))).rejects.toThrow(
      `[afterpack-test] failed to obfuscate ${file}: DIAG_PARSE_ERROR: unexpected token`,
    );
    expect(cap.all()).not.toContain("not returned on the Pro Cloud path");
    expect(readFileSync(file, "utf8")).toBe("export const a = 1;");
  });

  it("are counted on a successful cloud build instead of claiming none came back", async () => {
    __setProcessResult((input) => ({
      code: `OBF:${input}`,
      diagnostics: [{ severity: "info", code: "DIAG_TARGET_REACHED", message: "fine" }],
    }));
    __setBatchDecorator((result) => asCloudBatch(result));
    const cap = capture();
    const result = await runObfuscationPass(options({ logger: cap.logger }));
    expect(result.diagnostics.byCode).toEqual({ DIAG_TARGET_REACHED: 1 });
    expect(cap.all()).not.toContain("not returned on the Pro Cloud path");
  });
});

describe("server-supplied diagnostic fields", () => {
  it("reach the terminal with escape sequences and control characters stripped", async () => {
    const BEL = String.fromCharCode(0x07);
    __setProcessResult(() => ({
      code: "",
      diagnostics: [
        {
          severity: `info${ESC}[2J`,
          code: `DIAG_NOTE${String.fromCharCode(0x08)}`,
          message: "noted",
        },
        {
          severity: "error",
          code: `DIAG_${ESC}]8;;https://evil.example${BEL}X`,
          message: `bad${ESC}[31m input`,
        },
      ],
    }));
    __setBatchDecorator((result) => asCloudBatch(result));
    const cap = capture();
    const error = await runObfuscationPass(options({ logger: cap.logger })).catch(
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(Error);
    const printed = `${cap.all()}\n${(error as Error).message}`;
    expect(printed).not.toContain(ESC);
    expect(printed).not.toContain(BEL);
    expect(printed).not.toContain(String.fromCharCode(0x08));
    expect(printed).not.toContain("evil.example");
    expect(printed).toContain("error DIAG_X");
    expect(printed).toContain(": DIAG_X: bad input");
    expect(readFileSync(file, "utf8")).toBe("export const a = 1;");
  });
});

describe("the result status rule", () => {
  it("fails a file with an unknown status and writes nothing", async () => {
    __setBatchDecorator((result) => ({
      ...result,
      files: result.files.map((f) => ({ ...f, status: "skipped" })),
    }));
    await expect(runObfuscationPass(options({ logger: capture().logger }))).rejects.toThrow(
      /failed to obfuscate .*app\.js: the engine reported status "skipped"/,
    );
    expect(readFileSync(file, "utf8")).toBe("export const a = 1;");
    expect(existsSync(join(outDir, PROTECTION_RECEIPT_FILE))).toBe(false);
  });

  it("fails a file whose non-success status carries output anyway", async () => {
    __setBatchDecorator((result) => ({
      ...result,
      files: result.files.map((f) => ({ ...f, status: "partial", error: "half done" })),
    }));
    await expect(runObfuscationPass(options({ logger: capture().logger }))).rejects.toThrow(
      /app\.js: half done/,
    );
    expect(readFileSync(file, "utf8")).toBe("export const a = 1;");
  });

  it("fails a file whose result does not say whether it was obfuscated", async () => {
    __setBatchDecorator((result) => ({
      ...result,
      files: result.files.map(({ unobfuscated: _drop, ...f }) => f),
    }));
    await expect(runObfuscationPass(options({ logger: capture().logger }))).rejects.toThrow(
      /does not say whether the file was obfuscated/,
    );
    expect(readFileSync(file, "utf8")).toBe("export const a = 1;");
  });

  it("fails a file whose unobfuscated flag is not a boolean", async () => {
    __setBatchDecorator((result) => ({
      ...result,
      files: result.files.map((f) => ({ ...f, unobfuscated: "no" as unknown as boolean })),
    }));
    await expect(runObfuscationPass(options({ logger: capture().logger }))).rejects.toThrow(
      /does not say whether the file was obfuscated/,
    );
  });
});

describe("cloud refusals thrown by processBatch", () => {
  it("turns AFTERPACK_CLOUD_UPGRADE_REQUIRED into a CloudApiError and prints its notices", async () => {
    __setBatchError(
      napiError(
        "AFTERPACK_CLOUD_UPGRADE_REQUIRED",
        cloudErrorMessage({
          code: "DIAG_CLIENT_UPGRADE_REQUIRED",
          message: "this core is too old",
          details: { minVersion: "0.2.0" },
          notices: [
            {
              severity: "warning",
              code: "UPGRADE",
              message: "see the guide",
              url: "https://afterpack.dev/docs/upgrade",
            },
          ],
        }),
      ),
    );
    const cap = capture();
    const error = await runObfuscationPass(options({ client: IDENTITY, logger: cap.logger })).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CloudApiError);
    const cloud = error as CloudApiError;
    expect(cloud.kind).toBe("upgradeRequired");
    expect(cloud.code).toBe("AFTERPACK_CLOUD_UPGRADE_REQUIRED");
    expect(cloud.minVersion).toBe("0.2.0");
    expect(cloud.installed).toBe("0.1.2-rc.9");
    expect(cloud.message).toContain("[afterpack-test]");
    expect(cloud.message).toContain(
      "Installed @afterpack/core 0.1.2-rc.9 · required 0.2.0 or newer",
    );
    expect(cloud.fix).toBe("npm install @afterpack/vite@latest @afterpack/core@0.2.0");
    expect(cloud.message.split("\n")).toContain(cloud.fix);
    expect(cloud.message).not.toContain("npx");
    expect(cloud.message).toContain("this core is too old");
    expect(cap.warnings).toContain(
      "[afterpack-test] AfterPack warning: see the guide https://afterpack.dev/docs/upgrade",
    );
    expect(readFileSync(file, "utf8")).toBe("export const a = 1;");
  });

  it("names the calling plugin package in the command, with no npx alternative", async () => {
    __setBatchError(
      napiError(
        "AFTERPACK_CLOUD_UPGRADE_REQUIRED",
        cloudErrorMessage({
          code: "DIAG_CLIENT_UPGRADE_REQUIRED",
          message: "clients below 0.2.0 are no longer served",
          details: { minVersion: "0.2.0" },
        }),
      ),
    );
    const identity: ClientIdentity = {
      packageName: "@afterpack/next",
      packageVersion: "0.1.4",
      coreVersion: "0.1.0",
    };
    const error = (await runObfuscationPass(
      options({ client: identity, logger: capture().logger }),
    ).catch((e: unknown) => e)) as CloudApiError;
    expect(error.fix).toBe("npm install @afterpack/next@latest @afterpack/core@0.2.0");
    expect(error.message.split("\n")).toContain(error.fix);
    expect(error.message.split(error.fix)).toHaveLength(2);
    expect(error.message).not.toContain("npx");
  });

  it("turns AFTERPACK_CLOUD_SUNSET into a sunset CloudApiError", async () => {
    __setBatchError(
      napiError(
        "AFTERPACK_CLOUD_SUNSET",
        cloudErrorMessage({ code: "DIAG_API_SUNSET", message: "v1 is retired" }),
      ),
    );
    const error = await runObfuscationPass(options({ logger: capture().logger })).catch(
      (e: unknown) => e,
    );
    expect((error as CloudApiError).kind).toBe("sunset");
    expect((error as CloudApiError).message).toContain(
      "This version of AfterPack is no longer supported by the AfterPack cloud.",
    );
    expect((error as CloudApiError).message).toContain("v1 is retired");
  });

  it("keeps CODE: message for AFTERPACK_CLOUD_API", async () => {
    __setBatchError(
      napiError(
        "AFTERPACK_CLOUD_API",
        cloudErrorMessage({ code: "QUOTA_EXCEEDED", message: "monthly allowance used" }),
      ),
    );
    await expect(runObfuscationPass(options({ logger: capture().logger }))).rejects.toThrow(
      "[afterpack-test] cloud obfuscation failed: QUOTA_EXCEEDED: monthly allowance used",
    );
  });

  it("shows the raw text when the message is not the JSON lane", async () => {
    __setBatchError(napiError("AFTERPACK_CLOUD_API", `bad ${ESC}[31mgateway`));
    const error = (await runObfuscationPass(options({ logger: capture().logger })).catch(
      (e: unknown) => e,
    )) as CloudApiError;
    expect(error).toBeInstanceOf(CloudApiError);
    expect(error.apiCode).toBeNull();
    expect(error.message).toBe("[afterpack-test] cloud obfuscation failed: bad gateway");
  });

  it("rethrows every other failure untouched", async () => {
    const original = napiError("GenericFailure", "cloud unreachable: connect ETIMEDOUT");
    __setBatchError(original);
    const error = await runObfuscationPass(options({ logger: capture().logger })).catch(
      (e: unknown) => e,
    );
    expect(error).toBe(original);
  });
});
