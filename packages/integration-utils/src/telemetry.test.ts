import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineDiagnostic } from "./diagnostics.js";
import {
  buildTelemetryPayload,
  createTelemetryReporter,
  DEFAULT_API_URL,
  detectFrameworkVersion,
  durationBucket,
  fileCountBucket,
  frameworkFromLabel,
  INSTALL_ID_ROTATION_DAYS,
  resolveTelemetryEnabled,
  TELEMETRY_DIAGNOSTIC_LIMIT,
  TELEMETRY_ENDPOINT_PATH,
  TELEMETRY_NOTICE,
  type TelemetryFacts,
} from "./telemetry.js";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "afterpack-telemetry-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const critical: EngineDiagnostic = {
  severity: "critical",
  code: "DIAG_ENGINE_BUG_NO_PROGRESS",
  message: "no progress",
  span: null,
  file: "/home/alice/app/page.tsx",
  data: { kind: "engineBug", phase: "inflate", transform: "ScopeDeepen", nodeKind: null },
};

function facts(overrides: Partial<TelemetryFacts> = {}): TelemetryFacts {
  return {
    label: "afterpack-next",
    projectRoot: tmp(),
    diagnostics: [critical],
    fileCount: 12,
    durationMs: 2400,
    engineVersion: "0.0.10",
    ...overrides,
  };
}

function harness(env: Record<string, string | undefined> = {}) {
  const calls: { url: string; body: unknown }[] = [];
  const logs: string[] = [];
  const stateFile = join(tmp(), "telemetry.json");
  const fetchImpl = (async (url: unknown, init: unknown) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String((init as { body: string }).body)),
    });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  return {
    calls,
    logs,
    stateFile,
    deps: { env, logger: { log: (m: string) => logs.push(m) }, fetchImpl, stateFile },
  };
}

describe("resolveTelemetryEnabled", () => {
  it("defaults ON", () => {
    expect(resolveTelemetryEnabled(undefined, {})).toBe(true);
  });

  it("does NOT honor DO_NOT_TRACK — one flag, deliberately", () => {
    expect(resolveTelemetryEnabled(undefined, { DO_NOT_TRACK: "1" })).toBe(true);
  });

  it("takes the resolved `telemetry.enabled`, both ways", () => {
    expect(resolveTelemetryEnabled(false, {})).toBe(false);
    expect(resolveTelemetryEnabled(true, { NODE_ENV: "test" })).toBe(true);
  });

  it("treats a test run as not-a-build", () => {
    expect(resolveTelemetryEnabled(undefined, { NODE_ENV: "test" })).toBe(false);
    expect(resolveTelemetryEnabled(undefined, { VITEST: "true" })).toBe(false);
  });
});

describe("buckets", () => {
  it("buckets file counts so an exact count never travels", () => {
    expect(fileCountBucket(0)).toBe("0");
    expect(fileCountBucket(1)).toBe("1");
    expect(fileCountBucket(5)).toBe("2-5");
    expect(fileCountBucket(20)).toBe("6-20");
    expect(fileCountBucket(417)).toBe("101-500");
    expect(fileCountBucket(99999)).toBe("2000+");
  });

  it("buckets durations the same way", () => {
    expect(durationBucket(0)).toBe("<1s");
    expect(durationBucket(999)).toBe("<1s");
    expect(durationBucket(1000)).toBe("1-5s");
    expect(durationBucket(59999)).toBe("15-60s");
    expect(durationBucket(600000)).toBe("300s+");
    expect(durationBucket(Number.NaN)).toBe("unknown");
  });
});

describe("framework identity", () => {
  it("maps every front-door label onto the closed set", () => {
    expect(frameworkFromLabel("afterpack")).toBe("cli");
    expect(frameworkFromLabel("afterpack-vite")).toBe("vite");
    expect(frameworkFromLabel("afterpack-vite:main")).toBe("vite");
    expect(frameworkFromLabel("afterpack-vite:renderer")).toBe("vite");
    expect(frameworkFromLabel("afterpack-nonsense:main")).toBe("unknown");
    expect(frameworkFromLabel("afterpack-next")).toBe("next");
    expect(frameworkFromLabel("afterpack-angular")).toBe("angular");
  });

  it("refuses to carry an unrecognized label into the payload", () => {
    expect(frameworkFromLabel("my-company-internal-build-tool")).toBe("unknown");
  });

  it("reads the framework's DECLARED range and nothing else from package.json", () => {
    const dir = tmp();
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "acme-checkout",
        dependencies: { next: "^16.1.0", "internal-secret-lib": "1.0.0" },
      }),
    );
    expect(detectFrameworkVersion(dir, "next")).toBe("^16.1.0");
    expect(detectFrameworkVersion(dir, "vite")).toBeNull();
    expect(detectFrameworkVersion(dir, "cli")).toBeNull();
  });

  it("rejects any declaration that embeds a path", () => {
    const dir = tmp();
    for (const spec of ["file:../secret", "link:../secret", "workspace:*", "git+ssh://x/y.git"]) {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { vite: spec } }));
      expect(detectFrameworkVersion(dir, "vite")).toBeNull();
    }
  });

  it("survives a missing or unparseable package.json", () => {
    expect(detectFrameworkVersion(tmp(), "next")).toBeNull();
  });
});

describe("payload", () => {
  it("caps the diagnostic list at the server's own limit and counts the rest", () => {
    const many = Array.from({ length: TELEMETRY_DIAGNOSTIC_LIMIT + 5 }, (_, i) => ({
      ...critical,
      code: `DIAG_X_${i}`,
    }));
    const payload = buildTelemetryPayload(facts({ diagnostics: many }), {
      installId: "id",
      env: {},
    });
    expect(payload?.diagnostics).toHaveLength(TELEMETRY_DIAGNOSTIC_LIMIT);
    expect(payload?.droppedCount).toBe(5);
    expect(payload?.diagnostics.at(-1)?.code).toBe(`DIAG_X_${TELEMETRY_DIAGNOSTIC_LIMIT + 4}`);
    expect(payload?.criticalCount).toBe(TELEMETRY_DIAGNOSTIC_LIMIT + 5);
  });

  it("reports the preset name, and a raw numeric target as `custom`", () => {
    const named = buildTelemetryPayload(facts({ preset: "extreme" }), { installId: "i" });
    expect(named?.complexity).toBe("extreme");
    const raw = buildTelemetryPayload(facts({ preset: undefined, complexity: 7.25 }), {
      installId: "i",
    });
    expect(raw?.complexity).toBe("custom");
  });

  it("refuses a version string that is not one", () => {
    const p = buildTelemetryPayload(
      facts({ engineVersion: "/opt/build/engines/0.0.10", clientVersion: "0.0.11-rc.2" }),
      { installId: "i" },
    );
    expect(p?.engineVersion).toBeNull();
    expect(p?.clientVersion).toBe("0.0.11-rc.2");
  });
});

describe("reporter", () => {
  it("prints the first-run notice ONCE, before anything could be sent", async () => {
    const h = harness();
    const report = createTelemetryReporter(h.deps);
    await report(null);
    expect(h.logs).toEqual([...TELEMETRY_NOTICE]);
    expect(h.calls).toHaveLength(0);
    h.logs.length = 0;
    await report(facts());
    expect(h.logs).toEqual([]);
    expect(h.calls).toHaveLength(1);
  });

  it("says what it sends and how to turn it off", () => {
    const notice = TELEMETRY_NOTICE.join("\n");
    expect(notice).toContain("AFTERPACK_telemetry_enabled=false");
    expect(notice).toContain("--telemetry.enabled=false");
    expect(notice).toContain("telemetry: { enabled: false }");
    expect(notice).toContain("never sends your source");
    expect(notice).toContain("succeeds sends nothing");
    expect(notice).toContain("https://www.afterpack.dev/privacy");
  });

  it("POSTs to the shared API base, with the same install id across builds", async () => {
    const h = harness();
    const report = createTelemetryReporter(h.deps);
    await report(facts());
    await report(facts());
    expect(h.calls.map((c) => c.url)).toEqual([
      `${DEFAULT_API_URL}${TELEMETRY_ENDPOINT_PATH}`,
      `${DEFAULT_API_URL}${TELEMETRY_ENDPOINT_PATH}`,
    ]);
    const ids = h.calls.map((c) => (c.body as { installId: string }).installId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rotates the install id, so it is not a durable handle on a machine", async () => {
    const h = harness();
    let now = Date.UTC(2026, 0, 1);
    const report = createTelemetryReporter({ ...h.deps, now: () => now });
    await report(facts());
    now += (INSTALL_ID_ROTATION_DAYS + 1) * 24 * 60 * 60 * 1000;
    await report(facts());
    const [a, b] = h.calls.map((c) => (c.body as { installId: string }).installId);
    expect(a).not.toBe(b);
  });

  it("sends nothing at all for a build with no error or critical diagnostic", async () => {
    const h = harness();
    await createTelemetryReporter(h.deps)(facts({ diagnostics: [] }));
    expect(h.calls).toHaveLength(0);
  });

  it("is fail-open: a transport that throws is a non-event", async () => {
    const h = harness();
    const exploding = (() => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(
      createTelemetryReporter({ ...h.deps, fetchImpl: exploding })(facts()),
    ).resolves.toBeUndefined();
  });

  it("is fail-open: an unwritable state file still lets a build finish", async () => {
    const h = harness();
    const report = createTelemetryReporter({
      ...h.deps,
      stateFile: join(tmp(), "definitely", "not", "a", "dir\0", "state.json"),
    });
    await expect(report(facts())).resolves.toBeUndefined();
  });

  it("honors AFTERPACK_API_URL, the same override the cloud client reads", async () => {
    const h = harness({ AFTERPACK_API_URL: "https://staging-api.afterpack.dev/" });
    await createTelemetryReporter(h.deps)(facts());
    expect(h.calls[0].url).toBe(`https://staging-api.afterpack.dev${TELEMETRY_ENDPOINT_PATH}`);
  });

  it("persists only an id and two timestamps — no build history", async () => {
    const h = harness();
    await createTelemetryReporter(h.deps)(facts());
    const state = JSON.parse(readFileSync(h.stateFile, "utf8"));
    expect(Object.keys(state).sort()).toEqual(["installId", "noticeShownAt", "rotatedAt"]);
  });
});
