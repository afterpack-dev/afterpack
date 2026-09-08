import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EngineDiagnostic } from "./diagnostics.js";
import {
  buildTelemetryPayload,
  type TelemetryDiagnostic,
  type TelemetryFacts,
  telemetrySafeDiagnostic,
} from "./telemetry.js";

const WORKSPACE_PRIVATE_FIELDS = ["message", "file"] as const;

const TRANSMITTABLE_FIELDS = ["severity", "code", "span", "data"] as const;

function poisoned(): EngineDiagnostic {
  return {
    severity: "critical",
    message:
      'Unexpected token in /home/alice/secret-project/src/auth.ts: const API_KEY = "sk-live-abc";',
    code: "/home/alice/secret-project/src/auth.ts",
    span: { startByte: 12, endByte: 340 },
    file: "/home/alice/secret-project/src/auth.ts",
    data: {
      kind: "engineBug",
      phase: "/home/alice/secret-project/src/auth.ts",
      transform: 'const API_KEY = "sk-live-abc";',
      nodeKind: "Call",
      sourceExcerpt: 'const API_KEY = "sk-live-abc";',
      absolutePath: "/home/alice/secret-project/src/auth.ts",
      projectName: "secret-project",
    },
  };
}

const SENTINELS = [
  "/home/alice",
  "secret-project",
  "auth.ts",
  "sk-live-abc",
  "API_KEY",
  "Unexpected token in",
];

function scanForLeaks(value: unknown, path = "$"): string | null {
  if (typeof value === "string") {
    for (const sentinel of SENTINELS) {
      if (value.includes(sentinel))
        return `${path} carries the sentinel ${JSON.stringify(sentinel)}`;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      const hit = scanForLeaks(item, `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if ((WORKSPACE_PRIVATE_FIELDS as readonly string[]).includes(key)) {
        return `${path}.${key} is a workspace-private field name`;
      }
      const hit = scanForLeaks(item, `${path}.${key}`);
      if (hit) return hit;
    }
  }
  return null;
}

function projectWithPathDependency(): string {
  const dir = mkdtempSync(join(tmpdir(), "afterpack-telemetry-guard-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "secret-project", devDependencies: { vite: "file:../secret-project" } }),
  );
  return dir;
}

function facts(overrides: Partial<TelemetryFacts> = {}): TelemetryFacts {
  return {
    label: "afterpack-vite",
    projectRoot: projectWithPathDependency(),
    diagnostics: [poisoned()],
    fileCount: 417,
    durationMs: 8123,
    preset: "hard",
    engineVersion: "0.0.10",
    clientVersion: "0.0.10",
    ...overrides,
  };
}

const CTX = { installId: "11111111-2222-4333-8444-555555555555", env: {} };

const PAYLOAD_KEYS = [
  "version",
  "installId",
  "framework",
  "frameworkVersion",
  "engineVersion",
  "clientVersion",
  "nodeVersion",
  "os",
  "arch",
  "ci",
  "complexity",
  "fileCountBucket",
  "durationBucket",
  "diagnostics",
  "errorCount",
  "criticalCount",
  "droppedCount",
] as const;

const DIAGNOSTIC_KEYS = ["code", "severity", "span", "data"] as const;

describe("telemetry payload allowlist", () => {
  it("ships EXACTLY the reviewed keys, and nothing a refactor added", () => {
    const payload = buildTelemetryPayload(facts(), CTX);
    expect(payload).not.toBeNull();
    expect(Object.keys(payload as object).sort()).toEqual([...PAYLOAD_KEYS].sort());
  });

  it("ships EXACTLY the reviewed keys on every diagnostic", () => {
    const payload = buildTelemetryPayload(facts(), CTX);
    for (const d of payload?.diagnostics ?? []) {
      expect(Object.keys(d).sort()).toEqual([...DIAGNOSTIC_KEYS].sort());
    }
  });

  it("FIRES: a spread that smuggles raw facts is caught", () => {
    const smuggled = {
      ...(buildTelemetryPayload(facts(), CTX) as object),
      projectRoot: "/home/someone/secret-project",
      fileCount: 437,
      durationMs: 18234,
    };
    expect(Object.keys(smuggled).sort()).not.toEqual([...PAYLOAD_KEYS].sort());
    const extra = Object.keys(smuggled).filter(
      (k) => !(PAYLOAD_KEYS as readonly string[]).includes(k),
    );
    expect(extra.sort()).toEqual(["durationMs", "fileCount", "projectRoot"]);
  });

  it("FIRES: an extra key on a diagnostic is caught", () => {
    const d = { code: "X", severity: "error", span: null, data: null, file: "/x" };
    expect(Object.keys(d).sort()).not.toEqual([...DIAGNOSTIC_KEYS].sort());
  });
});

describe("telemetry payload guard", () => {
  it("keeps its two lists a partition of EngineDiagnostic's own fields", () => {
    const keys = Object.keys(poisoned()).sort();
    expect(keys).toEqual([...WORKSPACE_PRIVATE_FIELDS, ...TRANSMITTABLE_FIELDS].sort());
  });

  it("lets NOTHING workspace-private through, from a diagnostic poisoned in every field", () => {
    const payload = buildTelemetryPayload(facts(), CTX);
    expect(payload).not.toBeNull();
    expect(scanForLeaks(payload)).toBeNull();
    const wire = JSON.stringify(payload);
    for (const sentinel of SENTINELS) expect(wire).not.toContain(sentinel);
  });

  it("keeps the reviewed fields it is supposed to keep", () => {
    const payload = buildTelemetryPayload(facts(), CTX);
    expect(payload?.diagnostics).toEqual([
      {
        code: "DIAG_UNKNOWN",
        severity: "critical",
        span: { startByte: 12, endByte: 340 },
        data: { kind: "engineBug", nodeKind: "Call" },
      },
    ]);
    expect(payload?.criticalCount).toBe(1);
    expect(payload?.frameworkVersion).toBeNull();
    expect(payload?.fileCountBucket).toBe("101-500");
    expect(payload?.durationBucket).toBe("5-15s");
  });

  it("FIRES: the same scan rejects a payload that kept the private fields", () => {
    const payload = buildTelemetryPayload(facts(), CTX);
    const leaked = {
      ...payload,
      diagnostics: [{ ...poisoned() } as unknown as TelemetryDiagnostic],
    };
    expect(scanForLeaks(leaked)).toBe("$.diagnostics[0].message is a workspace-private field name");
  });

  it("FIRES: the scan rejects a private VALUE even under an innocuous key", () => {
    const payload = buildTelemetryPayload(facts(), CTX);
    const leaked = { ...payload, complexity: "/home/alice/secret-project" };
    expect(scanForLeaks(leaked)).toBe('$.complexity carries the sentinel "/home/alice"');
  });

  it("sends NOTHING for a build with no error or critical diagnostic", () => {
    const info: EngineDiagnostic = {
      severity: "info",
      code: "DIAG_ENGINE_PASSES",
      message: "/home/alice/secret-project/src/auth.ts inflated",
      span: null,
      file: "/home/alice/secret-project/src/auth.ts",
    };
    expect(buildTelemetryPayload(facts({ diagnostics: [info] }), CTX)).toBeNull();
    expect(buildTelemetryPayload(facts({ diagnostics: [] }), CTX)).toBeNull();
  });

  it("drops an UNREVIEWED data variant down to its tag", () => {
    const d: EngineDiagnostic = {
      severity: "error",
      code: "DIAG_SOMETHING_NEW",
      message: "boom",
      span: null,
      file: null,
      data: { kind: "brandNewVariant", sourceText: 'const API_KEY = "sk-live-abc";' },
    };
    expect(telemetrySafeDiagnostic(d, "error").data).toEqual({ kind: "brandNewVariant" });
  });
});

describe("telemetry projection compiles shut", () => {
  it("cannot be given a message or a file", () => {
    const safe: TelemetryDiagnostic = {
      code: "DIAG_PARSE_ERROR",
      severity: "error",
      span: null,
      data: null,
      // @ts-expect-error -- `message?: never` makes this a COMPILE error, which
      message: "leaked",
    };
    expect(safe.code).toBe("DIAG_PARSE_ERROR");
    const alsoSafe: TelemetryDiagnostic = {
      code: "DIAG_PARSE_ERROR",
      severity: "error",
      span: null,
      data: null,
      // @ts-expect-error -- `file?: never`, same reason.
      file: "/home/alice/secret-project/src/auth.ts",
    };
    expect(alsoSafe.severity).toBe("error");
  });
});

const PROJECTION_FUNCTIONS = [
  "telemetrySafeDiagnostic",
  "telemetrySafeData",
  "telemetrySafeSpan",
] as const;

const BANNED_CONSTRUCTS: readonly [RegExp, string][] = [
  [/\bmessage\b/, "names the workspace-private field `message`"],
  [/\bfile\b/, "names the workspace-private field `file`"],
  [/\.\.\.\s*\w/, "spreads its input instead of picking fields by name"],
  [/\bObject\.assign\b/, "copies its input wholesale via Object.assign"],
];

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} is gone — this guard stopped guarding`);
  const open = source.indexOf("{", source.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces scanning ${name}`);
}

function bannedConstruct(name: string, body: string): string | null {
  for (const [pattern, why] of BANNED_CONSTRUCTS) {
    if (pattern.test(body)) return `${name} ${why}`;
  }
  return null;
}

describe("telemetry projection source", () => {
  const source = readFileSync(new URL("./telemetry.ts", import.meta.url), "utf8");

  it("never names a workspace-private field, and never spreads its input", () => {
    for (const name of PROJECTION_FUNCTIONS) {
      expect(bannedConstruct(name, functionBody(source, name))).toBeNull();
    }
  });

  it("FIRES: the scan catches each way a projection can pick up a field", () => {
    const bypasses = [
      ["  return { code: d.code, message: d.message };", "message"],
      ["  return { code: d.code, file: d.file };", "file"],
      ["  return { ...d, code: d.code };", "spreads"],
      ["  return Object.assign({}, d);", "Object.assign"],
    ] as const;
    for (const [body, expected] of bypasses) {
      expect(bannedConstruct("probe", body)).toContain(expected);
    }
    expect(bannedConstruct("probe", "  return { code: d.code, span: d.span };")).toBeNull();
  });

  it("scans functions that actually exist", () => {
    for (const name of PROJECTION_FUNCTIONS) {
      expect(functionBody(source, name).length).toBeGreaterThan(40);
    }
  });
});
