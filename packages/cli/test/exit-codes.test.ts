import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __reset,
  __setBatchDecorator,
  __setBatchError,
  __setProcessResult,
  batchCalls,
  cloudErrorMessage,
  engineCalls,
  napiError,
  processBatch,
} from "../../../test/core-fake.js";
import { HELP_ALL } from "../src/args.js";
import { EXIT_CODE_HELP } from "../src/exit.js";
import { run } from "../src/run.js";

let root: string;
let buildDir: string;
let out: string[];
let err: string[];
let warn: string[];

const logger = {
  log: (m: string) => out.push(m),
  error: (m: string) => err.push(m),
  warn: (m: string) => warn.push(m),
};

const QUIET = ["--protectionMap.enabled=false", "--telemetry.enabled=false"];

function invoke(argv: string[], env: Record<string, string | undefined> = {}): Promise<number> {
  return run({
    argv,
    cwd: root,
    engine: { processBatch },
    logger,
    version: "9.9.9",
    env,
    stdout: { isTTY: false, write: () => {} },
  });
}

function document(): Record<string, unknown> {
  expect(out, "stdout must carry exactly one JSON document").toHaveLength(1);
  return JSON.parse(out[0]) as Record<string, unknown>;
}

function stageFreshBuildOutput(): void {
  writeFileSync(join(buildDir, "app.js"), "export const a = 1;");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "afterpack-exit-"));
  buildDir = join(root, "dist");
  mkdirSync(buildDir, { recursive: true });
  stageFreshBuildOutput();
  out = [];
  err = [];
  warn = [];
  __reset();
  __setProcessResult((input) => ({ code: `OBF:${input}`, sourceMap: null, protectionMap: null }));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the exit-code contract", () => {
  it("0 — every collected file was obfuscated", async () => {
    expect(await invoke(["dist", ...QUIET])).toBe(0);
  });

  it("1 — the engine failed, and the fix names what to do next", async () => {
    __setProcessResult(() => ({
      code: "",
      diagnostics: [{ severity: "error", code: "DIAG_PARSE_ERROR", message: "boom" }],
    }));
    expect(await invoke(["dist", ...QUIET])).toBe(1);
    expect(err.join("\n")).toContain("--paths.exclude");
    expect(readFileSync(join(buildDir, "app.js"), "utf8")).toBe("export const a = 1;");
  });

  it("2 — a file shipped unobfuscated, which only `allowUnobfuscated` permits", async () => {
    __setProcessResult((input) => ({ code: input, unobfuscated: true }));
    expect(await invoke(["dist", ...QUIET])).toBe(1);

    __reset();
    __setProcessResult((input) => ({ code: input, unobfuscated: true }));
    err = [];
    expect(await invoke(["dist", ...QUIET, "--allowUnobfuscated"])).toBe(2);
    expect(err.join("\n")).toContain("shipped UNOBFUSCATED");
    expect(err.join("\n")).toContain("drop --allowUnobfuscated");
  });

  it("3 — the size cap was reached, reported from the diagnostic on the throwing path", async () => {
    __setProcessResult(() => ({
      code: "",
      diagnostics: [
        {
          severity: "error",
          code: "DIAG_SIZE_CAP_REACHED",
          message: "inflation.max reached before complexity target",
        },
      ],
    }));
    expect(await invoke(["dist", ...QUIET])).toBe(3);
    expect(err.join("\n")).toContain("Raise --inflation.max");
  });

  it("4 and 5 are not documented at all — never emitted, never named", async () => {
    expect(EXIT_CODE_HELP).not.toContain("RESERVED");
    expect(EXIT_CODE_HELP).toContain("0   success");
    expect(EXIT_CODE_HELP).toContain("1   total failure");
    expect(EXIT_CODE_HELP).toContain("2   partial");
    expect(EXIT_CODE_HELP).toContain("3   size cap");
    expect(EXIT_CODE_HELP).toContain("6   update required");
    expect(EXIT_CODE_HELP).toContain("64  misuse");
    expect(HELP_ALL).toContain(EXIT_CODE_HELP);
    __setProcessResult((input) => ({
      code: `OBF:${input}`,
      diagnostics: [
        {
          severity: "info",
          code: "DIAG_REFLECTION_ANGULAR_ACKNOWLEDGED",
          message: "reflection acknowledged",
        },
      ],
    }));
    expect(await invoke(["dist", ...QUIET])).toBe(0);
  });

  it("6 — the cloud API requires a newer core: a fixed update line, the server's words, nothing written", async () => {
    __setBatchError(
      napiError(
        "AFTERPACK_CLOUD_UPGRADE_REQUIRED",
        cloudErrorMessage({
          code: "DIAG_CLIENT_UPGRADE_REQUIRED",
          message: "clients below 0.2.0 are no longer served",
          details: { minVersion: "0.2.0" },
          notices: [
            {
              severity: "warning",
              code: "UPGRADE",
              message: "upgrade guide",
              url: "https://www.afterpack.dev/docs/upgrade",
            },
          ],
        }),
      ),
    );
    const code = await run({
      argv: ["dist", ...QUIET, "--key=ap_live_x"],
      cwd: root,
      engine: { processBatch },
      logger,
      version: "0.1.0",
      env: {},
      stdout: { isTTY: false, write: () => {} },
      client: { packageName: "afterpack", packageVersion: "0.1.0", coreVersion: "0.1.0" },
    });
    expect(code).toBe(6);
    const text = [...err, ...warn, ...out].join("\n");
    expect(text).toContain(
      "This version of AfterPack is no longer supported by the AfterPack cloud.",
    );
    expect(text).toContain("Installed @afterpack/core 0.1.0 · required 0.2.0 or newer");
    expect(text).toContain("clients below 0.2.0 are no longer served");
    expect(text).toContain("Update, then build again:");
    expect(text).toContain("$ npm install afterpack@latest @afterpack/core@0.2.0");
    expect(text).toContain("or, without a local install: npx afterpack@latest");
    expect(text).toContain("https://www.afterpack.dev/docs/upgrade");
    expect(text).not.toContain("--paths.exclude");
    const fixOccurrences =
      text.split("npm install afterpack@latest @afterpack/core@0.2.0").length - 1;
    expect(fixOccurrences).toBe(1);
    expect(readFileSync(join(buildDir, "app.js"), "utf8")).toBe("export const a = 1;");
  });

  it("6 — a retired cloud API, reported in JSON with the server's code", async () => {
    __setBatchError(
      napiError(
        "AFTERPACK_CLOUD_SUNSET",
        cloudErrorMessage({ code: "DIAG_API_SUNSET", message: "this API version is retired" }),
      ),
    );
    expect(await invoke(["dist", ...QUIET, "--diagnostics.format=json"])).toBe(6);
    expect(document()).toMatchObject({
      exitCode: 6,
      ok: false,
      error: { code: "DIAG_API_SUNSET" },
    });
  });

  it("6 — an installed core below this afterpack's floor never reaches the engine", async () => {
    const code = await run({
      argv: ["dist", ...QUIET],
      cwd: root,
      engine: { processBatch },
      logger,
      version: "0.1.0",
      env: {},
      stdout: { isTTY: false, write: () => {} },
      client: { packageName: "afterpack", packageVersion: "0.1.0", coreVersion: "0.0.9" },
    });
    expect(code).toBe(6);
    const text = err.join("\n");
    expect(text).toContain("update @afterpack/core");
    expect(text).toContain("Update, then build again:");
    expect(text).toContain("$ npm install afterpack@latest @afterpack/core@latest");
    expect(text).toContain("or, without a local install: npx afterpack@latest");
    const fixOccurrences =
      text.split("npm install afterpack@latest @afterpack/core@latest").length - 1;
    expect(fixOccurrences).toBe(1);
    expect(batchCalls).toHaveLength(0);
  });

  it("1 — a receipt written by a newer AfterPack is refused with its own code, not BUILD_FAILED", async () => {
    writeFileSync(
      join(buildDir, ".afterpack-protection.json"),
      JSON.stringify({ schema: 9, outputs: {} }),
    );
    expect(await invoke(["dist", ...QUIET, "--diagnostics.format=json"])).toBe(1);
    expect(document()).toMatchObject({
      exitCode: 1,
      error: { code: "DIAG_RECEIPT_UNREADABLE" },
    });
    expect(readFileSync(join(buildDir, "app.js"), "utf8")).toBe("export const a = 1;");
  });

  it("1 — any other cloud API error keeps its CODE: message and is not an update", async () => {
    __setBatchError(
      napiError(
        "AFTERPACK_CLOUD_API",
        cloudErrorMessage({ code: "QUOTA_EXCEEDED", message: "monthly allowance used" }),
      ),
    );
    expect(await invoke(["dist", ...QUIET])).toBe(1);
    expect(err.join("\n")).toContain("QUOTA_EXCEEDED: monthly allowance used");
    expect(err.join("\n")).not.toContain("npm install");

    err = [];
    out = [];
    expect(await invoke(["dist", ...QUIET, "--diagnostics.format=json"])).toBe(1);
    expect(document()).toMatchObject({ exitCode: 1, error: { code: "QUOTA_EXCEEDED" } });
  });

  it("1 — a file with a status this CLI does not know is a failure, never written", async () => {
    __setBatchDecorator((result) => ({
      ...result,
      files: result.files.map((f) => ({
        ...f,
        status: "skipped" as unknown as (typeof result.files)[number]["status"],
      })),
    }));
    expect(await invoke(["dist", ...QUIET])).toBe(1);
    expect(readFileSync(join(buildDir, "app.js"), "utf8")).toBe("export const a = 1;");
  });

  it("64 — an unknown flag, a malformed value, a doubled path", async () => {
    expect(await invoke(["dist", "--nope=1"])).toBe(64);
    expect(await invoke(["dist", "--preset=hardened"])).toBe(64);
    expect(await invoke(["dist", "dist"])).toBe(64);
    expect(engineCalls).toHaveLength(0);
  });

  it("64 — a command this CLI does not have, pointed at the one that replaced it", async () => {
    expect(await invoke(["obfuscate", "dist/app.js"])).toBe(64);
    expect(err.join("\n")).toContain("`obfuscate` is not an afterpack command");
    expect(err.join("\n")).toContain("afterpack <path>");

    err = [];
    expect(await invoke(["scan", "dist"])).toBe(64);
    expect(err.join("\n")).toContain("the commands are `verify`, `restore` and `audit`");
    expect(engineCalls).toHaveLength(0);
  });

  it("1 — cloud-down on a Pro build fails closed and is never softened to 2", async () => {
    const engine = {
      processBatch: () => Promise.reject(new Error("cloud unreachable: connect ETIMEDOUT")),
    };
    const code = await run({
      argv: ["dist", ...QUIET, "--key=ap_live_x"],
      cwd: root,
      engine,
      logger,
      version: "9.9.9",
      env: {},
      stdout: { isTTY: false, write: () => {} },
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("cloud unreachable");
  });
});

describe("diagnostics.format=json", () => {
  it("puts ONE document on stdout and every human line on stderr", async () => {
    writeFileSync(join(buildDir, "b.js"), "export const b = 2;");
    expect(await invoke(["dist", ...QUIET, "--diagnostics.format=json", "--seed=4242"])).toBe(0);

    const doc = document();
    expect(doc).toMatchObject({ afterpack: "9.9.9", command: "obfuscate", exitCode: 0, ok: true });
    expect(doc.files).toEqual([
      {
        path: "dist/app.js",
        status: "obfuscated",
        bytesIn: 19,
        bytesOut: 23,
        diagnostics: [],
      },
      { path: "dist/b.js", status: "obfuscated", bytesIn: 19, bytesOut: 23, diagnostics: [] },
    ]);
    expect(doc.summary).toMatchObject({ files: 2, transformed: 2, seed: 4242, engine: "local" });
    expect(err.join("\n")).toContain("Protecting dist");
    expect(out.join("")).not.toContain("Protecting");
  });

  it("is byte-identical across two runs of the same build", async () => {
    const first = await invoke(["dist", ...QUIET, "--diagnostics.format=json", "--seed=7"]);
    const a = out[0];
    writeFileSync(join(buildDir, "app.js"), "export const a = 1;");
    out = [];
    __reset();
    __setProcessResult((input) => ({ code: `OBF:${input}`, sourceMap: null, protectionMap: null }));
    const second = await invoke(["dist", ...QUIET, "--diagnostics.format=json", "--seed=7"]);
    expect([first, second]).toEqual([0, 0]);
    expect(out[0]).toBe(a);
  });

  it("reports the engine diagnostics per file and rolled up, in a stable order", async () => {
    __setProcessResult((input) => ({
      code: `OBF:${input}`,
      diagnostics: [
        { severity: "info", code: "DIAG_TARGET_REACHED", message: "target reached" },
        { severity: "info", code: "DIAG_ENGINE_PASSES", message: "4  passes" },
      ],
    }));
    expect(await invoke(["dist", ...QUIET, "--diagnostics.format=json"])).toBe(0);
    const doc = document();
    const files = doc.files as { diagnostics: { code: string; message: string }[] }[];
    expect(files[0].diagnostics.map((d) => d.code)).toEqual([
      "DIAG_ENGINE_PASSES",
      "DIAG_TARGET_REACHED",
    ]);
    expect(files[0].diagnostics[0].message).toBe("4 passes");
    expect((doc.summary as { diagnostics: { byCode: unknown } }).diagnostics.byCode).toEqual({
      DIAG_ENGINE_PASSES: 1,
      DIAG_TARGET_REACHED: 1,
    });
  });

  it("names the combined Protection Map under artifacts", async () => {
    __setProcessResult((input) => ({ code: `OBF:${input}`, protectionMap: { files: [] } }));
    expect(
      await invoke([
        "dist",
        "--telemetry.enabled=false",
        "--protectionMap.enabled",
        "--diagnostics.format=json",
      ]),
    ).toBe(0);
    expect(document().artifacts).toEqual({ protectionMap: ".afterpack/protectionMap.html" });
  });

  it("emits the ERROR document, with the same exit code, on a failed build", async () => {
    __setProcessResult(() => ({
      code: "",
      diagnostics: [{ severity: "error", code: "DIAG_SIZE_CAP_REACHED", message: "cap reached" }],
    }));
    expect(await invoke(["dist", ...QUIET, "--diagnostics.format=json"])).toBe(3);
    const doc = document();
    expect(doc).toMatchObject({ command: "obfuscate", exitCode: 3, ok: false });
    expect(doc.error).toMatchObject({ code: "DIAG_SIZE_CAP_REACHED" });
    expect((doc.error as { fix: string }).fix).toContain("--inflation.max");
  });

  it("emits the ERROR document for a rejected configuration too", async () => {
    expect(await invoke(["dist", "--nope=1", "--diagnostics.format=json"])).toBe(64);
    expect(document()).toMatchObject({
      exitCode: 64,
      ok: false,
      error: { code: "INVALID_CONFIG" },
    });
  });

  it("comes from an AFTERPACK_ variable and from afterpack.json as well as a flag", async () => {
    expect(await invoke(["dist", ...QUIET], { AFTERPACK_diagnostics_format: "json" })).toBe(0);
    expect(document()).toMatchObject({ command: "obfuscate" });

    out = [];
    __reset();
    __setProcessResult((input) => ({ code: `OBF:${input}` }));
    stageFreshBuildOutput();
    writeFileSync(
      join(root, "afterpack.json"),
      JSON.stringify({ diagnostics: { format: "json" } }),
    );
    expect(await invoke(["dist", ...QUIET])).toBe(0);
    expect(document()).toMatchObject({ command: "obfuscate" });
  });
});

describe("diagnostics.level=none", () => {
  it("prints no progress and no summary, and still fails loudly", async () => {
    expect(await invoke(["dist", ...QUIET, "--diagnostics.level=none"])).toBe(0);
    expect(out).toEqual([]);

    __reset();
    __setProcessResult(() => ({
      code: "",
      diagnostics: [{ severity: "error", code: "DIAG_PARSE_ERROR", message: "boom" }],
    }));
    stageFreshBuildOutput();
    expect(await invoke(["dist", ...QUIET, "--diagnostics.level=none"])).toBe(1);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("boom");
    expect(warn.join("\n")).toContain("DIAG_PARSE_ERROR");
  });

  it("still prints the ONE json document, because that is the command's answer", async () => {
    expect(
      await invoke(["dist", ...QUIET, "--diagnostics.level=none", "--diagnostics.format=json"]),
    ).toBe(0);
    expect(document()).toMatchObject({ ok: true });
    expect(err).toEqual([]);
  });
});

describe("the document is machine-neutral", () => {
  it("spells every path project-relative, diagnostics included", async () => {
    __setProcessResult((input) => ({
      code: `OBF:${input}`,
      diagnostics: [{ severity: "info", code: "DIAG_ENGINE_PASSES", message: "4 passes" }],
    }));
    expect(await invoke(["dist", ...QUIET, "--diagnostics.format=json"])).toBe(0);
    const doc = document();
    expect((doc.diagnostics as { file: string }[])[0].file).toBe("dist/app.js");
    expect(out[0]).not.toContain(root);
  });
});
