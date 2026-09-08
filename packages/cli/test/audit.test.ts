import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { processBatch } from "../../../test/core-fake.js";
import { run } from "../src/run.js";

let server: Server;
let baseUrl: string;
let root: string;
let out: string[];
let err: string[];
let received: unknown[];

const logger = {
  log: (m: string) => out.push(m),
  error: (m: string) => err.push(m),
  warn: (m: string) => err.push(m),
};

type Handler = (respond: {
  event: (name: string, payload: unknown) => void;
  end: () => void;
}) => void;

let handler: Handler = ({ end }) => {
  end();
};
let rejectWith: { status: number; body: unknown } | null = null;

function listen(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
        if (rejectWith) {
          res.writeHead(rejectWith.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(rejectWith.body));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        handler({
          event: (name, payload) => {
            res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
          },
          end: () => res.end(),
        });
      });
    });
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

function invoke(argv: string[], env: Record<string, string | undefined> = {}): Promise<number> {
  return run({
    argv,
    cwd: root,
    engine: { processBatch },
    logger,
    version: "9.9.9",
    env: { AFTERPACK_API_URL: baseUrl, ...env },
    stdout: { isTTY: false, write: () => {} },
  });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "afterpack-audit-"));
  out = [];
  err = [];
  received = [];
  rejectWith = null;
  handler = ({ end }) => {
    end();
  };
  await listen();
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
});

const COMPLETE = {
  id: "scan_123",
  score: 42,
  resources: { total: 9, unprotected: 3, sourceExposed: 1 },
  findings: [
    { severity: "critical", title: "Stripe secret key in bundle", detail: "app.js:12" },
    { severity: "low", title: "Verbose error strings" },
  ],
  techStack: ["Next.js", "React"],
  readability: 88,
};

describe("afterpack audit", () => {
  it("streams the phases, prints the report link, and exits 0 even WITH findings", async () => {
    handler = ({ event, end }) => {
      event("progress", { phase: "Fetching page" });
      event("finding", { severity: "critical", title: "Stripe secret key in bundle" });
      event("progress", { phase: "Analyzing resources" });
      event("complete", COMPLETE);
      end();
    };

    expect(await invoke(["audit", "example.com"])).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("Fetching page");
    expect(text).toContain("Stripe secret key in bundle");
    expect(text).toContain("Score:");
    expect(text).toContain("https://www.afterpack.dev/security-scanner/scan_123");
    expect(received).toEqual([{ url: "https://example.com/" }]);
  });

  it("exits 1 with an actionable line when the scan itself fails", async () => {
    handler = ({ event, end }) => {
      event("error", { message: "target refused the fetch" });
      end();
    };
    expect(await invoke(["audit", "https://example.com"])).toBe(1);
    expect(err.join("\n")).toContain("target refused the fetch");
    expect(err.join("\n")).toContain("Retry the scan");
  });

  it("exits 1 when the stream ends without a completion event", async () => {
    handler = ({ event, end }) => {
      event("progress", { phase: "Fetching page" });
      end();
    };
    expect(await invoke(["audit", "https://example.com"])).toBe(1);
    expect(err.join("\n")).toContain("without a completion event");
  });

  it("turns a 429 into the friendly N-scans/24h message, not an HTTP error", async () => {
    rejectWith = {
      status: 429,
      body: { error: "rate_limited", scansIn24h: 3, retryAfterSeconds: 5400 },
    };
    expect(await invoke(["audit", "https://example.com"])).toBe(1);
    const text = err.join("\n");
    expect(text).toContain("3 scans / 24h");
    expect(text).toContain("Try again in 1h 30m");
    expect(text).not.toContain("429");
  });

  it("exits 64 on a missing, doubled or malformed URL", async () => {
    expect(await invoke(["audit"])).toBe(64);
    expect(err.join("\n")).toContain("audit needs a <url>");

    err = [];
    expect(await invoke(["audit", "a.com", "b.com"])).toBe(64);
    expect(err.join("\n")).toContain("single <url>");

    err = [];
    expect(await invoke(["audit", "http://"])).toBe(64);
    expect(err.join("\n")).toContain("not a URL");
    expect(received).toEqual([]);
  });

  it("rejects a flag this command does not have rather than ignoring it", async () => {
    expect(await invoke(["audit", "example.com", "--preset=hard"])).toBe(64);
    expect(err.join("\n")).toContain("not an option of `afterpack audit`");
    expect(received).toEqual([]);
  });

  it("prints its own help and exits 0", async () => {
    expect(await invoke(["audit", "--help"])).toBe(0);
    expect(out.join("\n")).toContain("usage: afterpack audit <url>");
    expect(out.join("\n")).toContain("Exit codes:");
    expect(await invoke(["audit", "-h"])).toBe(0);
  });

  it("emits ONE json document carrying the findings and the report URL", async () => {
    handler = ({ event, end }) => {
      event("complete", COMPLETE);
      end();
    };
    expect(await invoke(["audit", "example.com", "--diagnostics.format=json"])).toBe(0);
    expect(out).toHaveLength(1);
    const doc = JSON.parse(out[0]) as Record<string, unknown>;
    expect(doc).toMatchObject({
      afterpack: "9.9.9",
      command: "audit",
      exitCode: 0,
      ok: true,
      artifacts: { report: "https://www.afterpack.dev/security-scanner/scan_123" },
    });
    expect(doc.diagnostics).toEqual([
      {
        code: "AUDIT_FINDING",
        level: "critical",
        message: "Stripe secret key in bundle — app.js:12",
      },
      { code: "AUDIT_FINDING", level: "low", message: "Verbose error strings" },
    ]);
    expect(doc.summary).toMatchObject({ url: "https://example.com/", score: 42, findings: 2 });
  });

  it("emits a json ERROR document, with the same exit code, when the scan fails", async () => {
    rejectWith = { status: 429, body: { error: "rate_limited", scansIn24h: 3 } };
    expect(await invoke(["audit", "example.com", "--diagnostics.format=json"])).toBe(1);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0])).toMatchObject({
      command: "audit",
      exitCode: 1,
      ok: false,
      error: { code: "RATE_LIMITED" },
    });
  });

  it("reads the format from the environment as well as the flag", async () => {
    handler = ({ event, end }) => {
      event("complete", COMPLETE);
      end();
    };
    expect(await invoke(["audit", "example.com"], { AFTERPACK_diagnostics_format: "json" })).toBe(
      0,
    );
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0])).toMatchObject({ command: "audit" });
  });

  it("prints nothing at all on the happy path under diagnostics.level=none", async () => {
    handler = ({ event, end }) => {
      event("progress", { phase: "Fetching page" });
      event("complete", COMPLETE);
      end();
    };
    expect(await invoke(["audit", "example.com", "--diagnostics.level=none"])).toBe(0);
    expect(out).toEqual([]);
  });
});
