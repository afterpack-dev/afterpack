import { describe, expect, it } from "vitest";
import {
  collectDiagnostics,
  DIAG_ALREADY_OBFUSCATED,
  type EngineDiagnostic,
  formatAlreadyObfuscatedMessage,
  formatDiagnostic,
  parseDiagnosticsJson,
  reportDiagnostics,
  resolveDiagnosticsVerbosity,
  summarizeDiagnostics,
} from "./diagnostics.js";

function recorder() {
  const warnings: string[] = [];
  const logs: string[] = [];
  return {
    logger: { warn: (m: string) => warnings.push(m), log: (m: string) => logs.push(m) },
    warnings,
    logs,
    prefix: (m: string) => `[afterpack] ${m}`,
  };
}

const diag = (over: Partial<EngineDiagnostic>): EngineDiagnostic => ({
  severity: "info",
  code: "DIAG_TARGET_REACHED",
  message: "target reached",
  span: null,
  file: null,
  data: null,
  ...over,
});

describe("formatDiagnostic", () => {
  it("renders severity, code, file+span locator, message and every non-null data field", () => {
    const line = formatDiagnostic({
      severity: "critical",
      code: "DIAG_ENGINE_BUG_NO_PROGRESS",
      message: "no progress in pass 3",
      file: "/app/dist/chunk.js",
      span: { startByte: 1024, endByte: 1088 },
      data: { kind: "engineBug", phase: "inflate", transform: "ScopeDeepen", nodeKind: null },
    });
    expect(line).toBe(
      "critical DIAG_ENGINE_BUG_NO_PROGRESS · /app/dist/chunk.js bytes 1024..1088 · " +
        'no progress in pass 3 · phase="inflate" transform="ScopeDeepen"',
    );
  });

  it("omits the locator entirely when the engine gave neither file nor span", () => {
    expect(formatDiagnostic(diag({ code: "DIAG_ENGINE_PASSES", message: "3 passes" }))).toBe(
      "info DIAG_ENGINE_PASSES · 3 passes",
    );
  });

  it("renders a span-only locator without a file", () => {
    expect(formatDiagnostic(diag({ span: { startByte: 0, endByte: 9 } }))).toContain(
      "· bytes 0..9 ·",
    );
  });

  it("collapses a multi-line message onto the single line", () => {
    expect(formatDiagnostic(diag({ message: "expected `;`\n  found `}`" }))).toContain(
      "· expected `;` found `}`",
    );
  });

  it("drops a data payload whose fields are all null rather than printing a bare tag", () => {
    const line = formatDiagnostic(
      diag({ data: { kind: "engineBug", phase: null, transform: null, nodeKind: null } }),
    );
    expect(line).toBe("info DIAG_TARGET_REACHED · target reached");
  });
});

describe("parseDiagnosticsJson", () => {
  it("distinguishes a genuinely clean file from an absent lane", () => {
    expect(parseDiagnosticsJson("[]")).toEqual({ diagnostics: [], malformed: 0 });
    expect(parseDiagnosticsJson(undefined)).toBeNull();
    expect(parseDiagnosticsJson(null)).toBeNull();
  });

  it("round-trips a diagnostic with its span, file and tagged data intact", () => {
    const d = diag({
      severity: "error",
      code: "DIAG_PARSE_ERROR",
      file: "/d/a.js",
      span: { startByte: 1, endByte: 2 },
      data: { kind: "parseError", parserErrorKind: "Expected" },
    });
    expect(parseDiagnosticsJson(JSON.stringify([d]))).toEqual({
      diagnostics: [d],
      malformed: 0,
    });
  });

  it("reports UNKNOWN rather than throwing on a malformed or non-array payload", () => {
    expect(parseDiagnosticsJson("{oops")).toBeNull();
    expect(parseDiagnosticsJson('{"severity":"info"}')).toBeNull();
  });

  it("counts entries the contract guard dropped instead of passing them off as clean", () => {
    const payload = JSON.stringify([diag({}), { severity: "info" }, null, 7]);
    expect(parseDiagnosticsJson(payload)).toEqual({ diagnostics: [diag({})], malformed: 3 });
  });
});

describe("collectDiagnostics", () => {
  it("attributes a file-less diagnostic to the carrier, and leaves an owned file alone", () => {
    const collected = collectDiagnostics([
      { filePath: "/d/a.js", diagnostics: JSON.stringify([diag({})]) },
      { filePath: "/d/b.js", diagnostics: JSON.stringify([diag({ file: "/src/real.ts" })]) },
    ]);
    expect(collected.diagnostics.map((d) => d.file)).toEqual(["/d/a.js", "/src/real.ts"]);
    expect(collected).toMatchObject({ unknownFiles: 0, malformedEntries: 0 });
  });

  it("counts an absent lane and a dropped entry apart — they are different facts", () => {
    const collected = collectDiagnostics([
      { filePath: "/d/a.js" },
      { filePath: "/d/b.js", diagnostics: JSON.stringify([{ severity: "info" }]) },
      { filePath: "/d/c.js", diagnostics: "[]" },
    ]);
    expect(collected).toEqual({ diagnostics: [], unknownFiles: 1, malformedEntries: 1 });
  });
});

describe("summarizeDiagnostics", () => {
  it("tallies by severity and by stable code", () => {
    expect(
      summarizeDiagnostics([
        diag({ severity: "error", code: "DIAG_PARSE_ERROR" }),
        diag({ severity: "error", code: "DIAG_PARSE_ERROR" }),
        diag({ severity: "critical", code: "DIAG_ENGINE_BUG_NO_PROGRESS" }),
        diag({}),
      ]),
    ).toEqual({
      total: 4,
      info: 1,
      error: 2,
      critical: 1,
      byCode: { DIAG_PARSE_ERROR: 2, DIAG_ENGINE_BUG_NO_PROGRESS: 1, DIAG_TARGET_REACHED: 1 },
    });
  });
});

describe("resolveDiagnosticsVerbosity", () => {
  it("defaults to summary and takes the resolved level otherwise", () => {
    expect(resolveDiagnosticsVerbosity(undefined)).toBe("summary");
    expect(resolveDiagnosticsVerbosity("all")).toBe("all");
    expect(resolveDiagnosticsVerbosity("summary")).toBe("summary");
  });
});

describe("reportDiagnostics", () => {
  it("prints nothing at all for a clean build", () => {
    const r = recorder();
    expect(
      reportDiagnostics({ diagnostics: [], logger: r.logger, prefix: r.prefix }),
    ).toMatchObject({ total: 0 });
    expect(r.warnings).toEqual([]);
    expect(r.logs).toEqual([]);
  });

  it("warns every error and critical in full, criticals first, and rolls info up to one line", () => {
    const r = recorder();
    reportDiagnostics({
      diagnostics: [
        diag({}),
        diag({ code: "DIAG_ENGINE_PASSES", message: "4 passes" }),
        diag({
          severity: "error",
          code: "DIAG_PARSE_ERROR",
          message: "failed to parse",
          file: "/d/a.js",
          data: { kind: "parseError", parserErrorKind: "Expected" },
        }),
        diag({
          severity: "critical",
          code: "DIAG_ENGINE_BUG_PROCESS_THREAD_PANIC",
          message: "worker panicked",
        }),
      ],
      logger: r.logger,
      prefix: r.prefix,
    });
    expect(r.warnings).toEqual([
      "[afterpack] critical DIAG_ENGINE_BUG_PROCESS_THREAD_PANIC · worker panicked",
      '[afterpack] error DIAG_PARSE_ERROR · /d/a.js · failed to parse · parserErrorKind="Expected"',
      "[afterpack] 1 critical diagnostic(s) above are engine bugs — please report them at " +
        "https://github.com/afterpack-dev/afterpack/issues, quoting the code(s).",
    ]);
    expect(r.logs).toEqual([
      "[afterpack] 2 info diagnostic(s): DIAG_ENGINE_PASSES x1 · DIAG_TARGET_REACHED x1 " +
        "(AFTERPACK_diagnostics_level=all to list them)",
    ]);
  });

  it("caps repeated error instances per code but still counts the remainder", () => {
    const r = recorder();
    const many = Array.from({ length: 9 }, (_, i) =>
      diag({ severity: "error", code: "DIAG_PARSE_ERROR", file: `/d/${i}.js` }),
    );
    reportDiagnostics({ diagnostics: many, logger: r.logger, prefix: r.prefix });
    expect(r.warnings).toHaveLength(6);
    expect(r.warnings[5]).toBe(
      "[afterpack] error DIAG_PARSE_ERROR · +4 more occurrence(s) " +
        "(AFTERPACK_diagnostics_level=all to list them)",
    );
  });

  it("lists every diagnostic, uncapped, at `all` verbosity", () => {
    const r = recorder();
    const many = Array.from({ length: 9 }, (_, i) =>
      diag({ severity: "error", code: "DIAG_PARSE_ERROR", file: `/d/${i}.js` }),
    );
    reportDiagnostics({
      diagnostics: [...many, diag({}), diag({})],
      logger: r.logger,
      prefix: r.prefix,
      verbosity: "all",
    });
    expect(r.warnings).toHaveLength(9);
    expect(r.warnings.some((w) => w.includes("more occurrence(s)"))).toBe(false);
    expect(r.logs).toEqual([
      "[afterpack] 2 info diagnostic(s): DIAG_TARGET_REACHED x2",
      "[afterpack] info DIAG_TARGET_REACHED · target reached",
      "[afterpack] info DIAG_TARGET_REACHED · target reached",
    ]);
  });

  it("says the diagnostics are incomplete when the contract guard dropped entries", () => {
    const r = recorder();
    reportDiagnostics({
      diagnostics: [],
      malformedEntries: 2,
      logger: r.logger,
      prefix: r.prefix,
    });
    expect(r.warnings).toEqual([
      "[afterpack] 2 diagnostic entry/entries did not match the engine's diagnostic contract " +
        "and were dropped — treat this build's diagnostics as incomplete.",
    ]);
  });

  it("names the loudest codes first and counts the rest when many info codes fire", () => {
    const r = recorder();
    const codes = ["A", "B", "C", "D", "E", "F", "G", "H"];
    const diagnostics = codes.flatMap((c, i) =>
      Array.from({ length: codes.length - i }, () => diag({ code: `DIAG_${c}` })),
    );
    reportDiagnostics({ diagnostics, logger: r.logger, prefix: r.prefix });
    expect(r.logs[0]).toBe(
      "[afterpack] 36 info diagnostic(s): DIAG_A x8 · DIAG_B x7 · DIAG_C x6 · DIAG_D x5 · " +
        "DIAG_E x4 · DIAG_F x3 · +2 more code(s) (AFTERPACK_diagnostics_level=all to list them)",
    );
  });
});

describe("formatAlreadyObfuscatedMessage", () => {
  it("names the code, every file, the receipt, and the fix — under the cap", () => {
    const message = formatAlreadyObfuscatedMessage({
      files: ["/out/a.js", "/out/b.js"],
      receiptPath: "/out/.afterpack-protection.json",
      dir: "/out",
    });
    expect(message).toBe(
      `error ${DIAG_ALREADY_OBFUSCATED} · 2 file(s) already carry AfterPack's obfuscated output ` +
        "from a previous run (matched by content hash against /out/.afterpack-protection.json): " +
        "/out/a.js, /out/b.js — rebuild from source before running AfterPack again " +
        "(delete `/out` or run your bundler's clean); AfterPack output is not idempotent",
    );
  });

  it("caps the file list and says how many more, past the cap", () => {
    const files = Array.from({ length: 13 }, (_, i) => `/out/f${i}.js`);
    const message = formatAlreadyObfuscatedMessage({
      files,
      receiptPath: "/out/.afterpack-protection.json",
      dir: "/out",
    });
    expect(message).toContain(files.slice(0, 10).join(", "));
    expect(message).toContain(", and 3 more");
    expect(message).not.toContain("f10.js");
  });

  it("lists every file with no overflow suffix when the count is exactly the cap", () => {
    const files = Array.from({ length: 10 }, (_, i) => `/out/f${i}.js`);
    const message = formatAlreadyObfuscatedMessage({
      files,
      receiptPath: "/out/.afterpack-protection.json",
      dir: "/out",
    });
    expect(message).not.toContain("more");
  });
});
