import { generateKeyPairSync } from "node:crypto";
import * as zlib from "node:zlib";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import nacl from "tweetnacl";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNetworkProtection,
  DEFAULT_MAX_SEALED_BODY_BYTES,
  generateKeyPair,
  publicKeyFor,
  REFUSAL_STATUS,
} from "../src/index.js";
import {
  base64urlToBytes,
  echo,
  json,
  ORIGIN,
  post,
  roundTrip,
  setup,
  TUNNEL,
  tunnelRequest,
} from "./harness.js";
import { decodeOuter, type Encoding, encodeOuter, Np1TestClient } from "./np1-client.js";

const ENCODINGS: Encoding[] = ["raw", "base64", "base64url", "json"];
const byTestAddress = (request: Request) => request.headers.get("cf-connecting-ip");
const utf8 = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");

function supports(format: string): boolean {
  try {
    new DecompressionStream(format as CompressionFormat);
    return true;
  } catch {
    return false;
  }
}

function zstdOf(text: string): Uint8Array | null {
  const compress = (zlib as { zstdCompressSync?: (input: Buffer) => Buffer }).zstdCompressSync;
  return compress === undefined ? null : new Uint8Array(compress(Buffer.from(text)));
}

function countedStream(bytes: Uint8Array, chunk: number) {
  const pulls = { bytes: 0 };
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        const part = bytes.slice(offset, offset + chunk);
        offset += part.length;
        pulls.bytes += part.length;
        controller.enqueue(part);
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulls };
}

function streamedPost(url: string, stream: ReadableStream<Uint8Array>, length: number | null) {
  const headers: Record<string, string> = { "sec-fetch-site": "same-origin", origin: ORIGIN };
  if (length !== null) headers["content-length"] = String(length);
  return new Request(url, { method: "POST", body: stream, headers, duplex: "half" } as RequestInit);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("handle: a sealed round trip with the independent client", () => {
  for (const encoding of ENCODINGS) {
    it(`carries kind 1 and kind 2 in ${encoding}`, async () => {
      const ctx = setup();
      for (const ratio of [1.5, 2, null]) {
        const client = ctx.client(ratio);
        const body = new Uint8Array(3000).map((_, i) => (i * 31) & 0xff);
        const { outer, outerBody, opened } = await roundTrip(
          ctx,
          client,
          {
            method: "PUT",
            target: "/api/items/7?full=1&q=caf%C3%A9",
            headers: [
              ["content-type", "application/octet-stream"],
              ["authorization", "Bearer inner"],
              ["x-tag", "a"],
              ["x-tag", "b"],
              ["x-note", "café"],
            ],
            body,
          },
          encoding,
        );
        expect(outer.status).toBe(200);
        expect(outer.headers.get("cache-control")).toBe("no-store");
        expect(outer.headers.get("content-type")).toBe(
          {
            raw: "application/octet-stream",
            base64: "text/plain;charset=UTF-8",
            base64url: "text/plain;charset=UTF-8",
            json: "application/json",
          }[encoding],
        );
        if (encoding === "json") expect(Object.keys(JSON.parse(utf8(outerBody)))).toEqual(["zk"]);
        if (encoding === "base64url") expect(utf8(outerBody)).toMatch(/^[A-Za-z0-9_-]+$/);
        if (encoding === "base64") expect(utf8(outerBody)).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
        expect(opened?.status).toBe(200);
        expect(opened?.headers).toContainEqual(["content-type", "application/json"]);
        const seen = json(opened);
        expect(seen.method).toBe("PUT");
        expect(seen.url).toBe(`${ORIGIN}/api/items/7?full=1&q=caf%C3%A9`);
        expect(Buffer.from(seen.body, "base64")).toEqual(Buffer.from(body));
        const headers = new Map(seen.headers);
        expect(headers.get("authorization")).toBe("Bearer inner");
        expect(headers.get("x-tag")).toBe("a, b");
        expect(headers.get("x-note")).toBe("café");
        expect(headers.get("content-type")).toBe("application/octet-stream");
      }
    });
  }

  it("carries every method, an empty body and a GET query", async () => {
    const ctx = setup();
    const client = ctx.client();
    for (const method of ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"]) {
      const { opened } = await roundTrip(
        ctx,
        client,
        { method, target: "/api/m?x=1" },
        "raw",
        async (r) => {
          return new Response(method === "HEAD" ? null : `${r.method} ${new URL(r.url).search}`, {
            status: 201,
          });
        },
      );
      expect(opened?.status).toBe(201);
      expect(utf8(opened?.body ?? new Uint8Array())).toBe(
        method === "HEAD" ? "" : `${method} ?x=1`,
      );
    }
  });

  it("answers in the request's encoding and JSON key, whichever the build chose", async () => {
    const ctx = setup();
    const client = ctx.client();
    for (const key of ["q7", "data", "__proto__", "ключ"]) {
      const sealed = client.sealRequest({ method: "GET", target: "/api/x" }, "json", key);
      const outer = await ctx.protection.handle(tunnelRequest(sealed), echo);
      const text = await outer.text();
      expect(Object.keys(JSON.parse(text))).toEqual([key]);
      expect(text.startsWith(`{${JSON.stringify(key)}:"`)).toBe(true);
      expect(client.openResponse(new Uint8Array(Buffer.from(text)), "json").status).toBe(200);
    }
  });

  it("reuses a session for every request of one page session", async () => {
    const ctx = setup({ freshSessionsPerMinute: 1, clientAddress: byTestAddress });
    const client = ctx.client();
    for (let i = 0; i < 5; i++) {
      const { opened } = await roundTrip(
        ctx,
        client,
        { method: "GET", target: `/api/n/${i}` },
        "raw",
        echo,
        {
          "cf-connecting-ip": "10.0.0.1",
        },
      );
      expect(json(opened).url).toBe(`${ORIGIN}/api/n/${i}`);
    }
  });

  it("opens records sealed to any of the rotated keys", async () => {
    const fresh = generateKeyPair();
    const old = generateKeyPair();
    const protection = createNetworkProtection({
      privateKeys: `${fresh.privateKey},${old.privateKey}`,
      routes: { include: ["/api/**"] },
    });
    for (const pair of [old, fresh]) {
      const client = new Np1TestClient({ serverPublic: base64urlToBytes(pair.publicKey) });
      const sealed = client.sealRequest({ method: "GET", target: "/api/r" }, "base64url");
      const outer = await protection.handle(tunnelRequest(sealed), echo);
      expect(outer.status).toBe(200);
      const opened = client.openResponse(new Uint8Array(await outer.arrayBuffer()), "base64url");
      expect(json(opened).url).toBe(`${ORIGIN}/api/r`);
    }
  });
});

describe("handle: response sealing", () => {
  it("seals every response under a fresh nonce, even one session's identical responses", async () => {
    const ctx = setup();
    const client = ctx.client();
    const records: Uint8Array[] = [];
    for (let i = 0; i < 3; i++) {
      const sealed = client.sealRequest({ method: "GET", target: "/api/same" }, "raw");
      const outer = await ctx.protection.handle(tunnelRequest(sealed), () => new Response("same"));
      const body = new Uint8Array(await outer.arrayBuffer());
      expect(utf8(client.openResponse(body, "raw").body)).toBe("same");
      records.push(decodeOuter(body, "raw"));
    }
    const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
    expect(new Set(records.map((record) => hex(record.subarray(0, 24)))).size).toBe(3);
    expect(new Set(records.map((record) => hex(record.subarray(24)))).size).toBe(3);
  });

  it("seals a 500 and reports it when next throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = setup();
    for (const next of [
      () => {
        throw new Error("secret detail /srv/app.js:12");
      },
      () => Promise.reject(new Error("secret detail")),
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("secret detail"));
            },
          }),
          { headers: { "set-cookie": "half=1" } },
        ),
    ]) {
      const { outer, outerBody, opened } = await roundTrip(
        ctx,
        ctx.client(),
        { method: "POST", target: "/api/boom" },
        "base64url",
        next,
      );
      expect(outer.status).toBe(200);
      expect(outer.headers.getSetCookie()).toEqual([]);
      expect(utf8(outerBody)).not.toContain("secret");
      expect(opened?.status).toBe(500);
      expect(opened?.headers).toEqual([]);
      expect(opened?.body).toEqual(new Uint8Array(0));
    }
    expect(ctx.infos.map((i) => [i.info.status, i.info.sealed, i.info.path])).toEqual([
      [500, true, "/api/boom"],
      [500, true, "/api/boom"],
      [500, true, "/api/boom"],
    ]);
    expect(ctx.protection.counters).toMatchObject({ sealed: 3 });
    expect(error).toHaveBeenCalledTimes(3);
    error.mockRestore();
  });

  it("pads the inner response to the server ladder", async () => {
    const ctx = setup();
    const client = ctx.client();
    for (const [size, bucket] of [
      [0, 256],
      [300, 512],
      [3000, 4096],
      [40_000, 65_536],
      [70_000, 131_072],
    ]) {
      const sealed = client.sealRequest({ method: "GET", target: "/api/p" }, "raw");
      const outer = await ctx.protection.handle(
        tunnelRequest(sealed),
        () => new Response(new Uint8Array(size)),
      );
      const wire = decodeOuter(new Uint8Array(await outer.arrayBuffer()), "raw");
      const inner = nacl.secretbox.open(wire.subarray(24), wire.subarray(0, 24), client.key);
      expect(inner?.length, `${size}`).toBe(bucket);
    }
  });

  it("returns an inner 3xx untouched", async () => {
    const ctx = setup();
    const { outer, opened } = await roundTrip(
      ctx,
      ctx.client(),
      { method: "POST", target: "/api/login" },
      "base64",
      () => new Response(null, { status: 302, headers: { location: "/api/home" } }),
    );
    expect(outer.status).toBe(200);
    expect(outer.headers.get("location")).toBeNull();
    expect(opened?.status).toBe(302);
    expect(opened?.headers).toContainEqual(["location", "/api/home"]);
  });

  it("hoists two Set-Cookie values onto the outer response as two headers", async () => {
    const ctx = setup();
    const { outer, opened } = await roundTrip(
      ctx,
      ctx.client(),
      { method: "POST", target: "/api/login" },
      "json",
      () => {
        const headers = new Headers({ "content-type": "text/plain" });
        headers.append("set-cookie", "a=1; Path=/; HttpOnly");
        headers.append("set-cookie", "b=2; Path=/; Secure");
        return new Response("ok", { headers });
      },
    );
    expect(outer.headers.getSetCookie()).toEqual(["a=1; Path=/; HttpOnly", "b=2; Path=/; Secure"]);
    expect(opened?.headers.map(([name]) => name)).not.toContain("set-cookie");
    expect(opened?.headers).toContainEqual(["content-type", "text/plain"]);
  });

  it("keeps the app's status and error bodies inside, with the outer response always 200", async () => {
    const ctx = setup();
    const { outer, opened } = await roundTrip(
      ctx,
      ctx.client(),
      { method: "GET", target: "/api/missing" },
      "raw",
      () => new Response("not found", { status: 404 }),
    );
    expect(outer.status).toBe(200);
    expect(opened?.status).toBe(404);
    expect(utf8(opened?.body ?? new Uint8Array())).toBe("not found");
  });

  it("asks next for an uncompressed response, whatever the browser accepts", async () => {
    const ctx = setup();
    const { opened } = await roundTrip(
      ctx,
      ctx.client(),
      { method: "GET", target: "/api/z", headers: [["accept-encoding", "gzip"]] },
      "raw",
      echo,
      { "accept-encoding": "gzip, deflate, br, zstd" },
    );
    const sent = json(opened).headers.filter(([name]) => name === "accept-encoding");
    expect(sent).toEqual([["accept-encoding", "identity"]]);
  });

  it("seals the decoded body of a response next compressed anyway", async () => {
    const payload = JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => `item-${i}`) });
    for (const [coding, compress] of [
      ["gzip", (b: Buffer) => gzipSync(b)],
      ["x-gzip", (b: Buffer) => gzipSync(b)],
      ["deflate", (b: Buffer) => deflateSync(b)],
      ["deflate, gzip", (b: Buffer) => gzipSync(deflateSync(b))],
    ] as const) {
      const ctx = setup();
      const { opened } = await roundTrip(
        ctx,
        ctx.client(),
        { method: "GET", target: "/api/z" },
        "base64url",
        () =>
          new Response(new Uint8Array(compress(Buffer.from(payload))), {
            headers: { "content-encoding": coding, "content-type": "application/json" },
          }),
      );
      expect(opened?.status, coding).toBe(200);
      expect(utf8(opened?.body ?? new Uint8Array()), coding).toBe(payload);
      expect(opened?.headers, coding).toEqual([["content-type", "application/json"]]);
    }
  });

  it("decodes br and zstd through DecompressionStream where the runtime has the format", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const payload = JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => `item-${i}`) });
    const brotli = new Uint8Array(brotliCompressSync(Buffer.from(payload)));
    const zstd = zstdOf(payload);
    const cases: [string, Uint8Array | null, string][] = [
      ["br", brotli, "brotli"],
      ["br, gzip", new Uint8Array(gzipSync(brotli)), "brotli"],
      ["zstd", zstd, "zstd"],
    ];
    let failures = 0;
    for (const [coding, body, format] of cases) {
      if (body === null) continue;
      const ctx = setup();
      const { opened } = await roundTrip(
        ctx,
        ctx.client(),
        { method: "GET", target: "/api/z" },
        "raw",
        () =>
          new Response(new Uint8Array(body), {
            headers: { "content-encoding": coding, "content-type": "application/json" },
          }),
      );
      if (supports(format)) {
        expect(opened?.status, coding).toBe(200);
        expect(utf8(opened?.body ?? new Uint8Array()), coding).toBe(payload);
        expect(opened?.headers, coding).toEqual([["content-type", "application/json"]]);
      } else {
        failures += 1;
        expect(opened?.status, coding).toBe(502);
      }
    }
    expect(error).toHaveBeenCalledTimes(failures);
    error.mockRestore();
  });

  it("answers a sealed 502 for a coding the runtime can't decode or a body that fails to", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const payload = "x".repeat(2048);
    const cases: [string, Uint8Array][] = [
      ["compress", new Uint8Array(Buffer.from(payload))],
      ["x-custom", new Uint8Array(Buffer.from(payload))],
      ["gzip", new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3, 4, 5])],
    ];
    if (supports("brotli")) cases.push(["br", new Uint8Array([0xff, 0xff, 0xff, 0xff])]);
    if (!supports("zstd")) cases.push(["zstd", new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0, 0])]);
    for (const [coding, body] of cases) {
      const ctx = setup();
      const { opened } = await roundTrip(
        ctx,
        ctx.client(),
        { method: "GET", target: "/api/z" },
        "raw",
        () => new Response(new Uint8Array(body), { headers: { "content-encoding": coding } }),
      );
      expect(opened?.status, coding).toBe(502);
      expect(opened?.body.length, coding).toBe(0);
      expect(opened?.headers, coding).toEqual([]);
      expect(ctx.infos[0].info.status, coding).toBe(502);
    }
    expect(error).toHaveBeenCalledTimes(cases.length);
    expect(String(error.mock.calls[0][0])).toContain('"compress"');
    error.mockRestore();
  });

  it("keeps a fetched body as is, whatever its Content-Encoding says", async () => {
    const payload = "x".repeat(2048);
    const ctx = setup();
    const fetched = new Response(payload, { headers: { "content-encoding": "br" } });
    Object.defineProperty(fetched, "url", { value: "https://upstream.example/data" });
    const { opened } = await roundTrip(
      ctx,
      ctx.client(),
      { method: "GET", target: "/api/z" },
      "raw",
      () => fetched,
    );
    expect(opened?.status).toBe(200);
    expect(utf8(opened?.body ?? new Uint8Array())).toBe(payload);
  });

  it('seals every body as read with responseBodies "decoded", for any coding', async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const payload = JSON.stringify({ items: Array.from({ length: 50 }, (_, i) => `item-${i}`) });
    const gzipLookalike = new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3, 4, 5]);
    const cases: [string, Uint8Array][] = [
      ["br", new Uint8Array(Buffer.from(payload))],
      ["zstd", new Uint8Array(Buffer.from(payload))],
      ["gzip", new Uint8Array(Buffer.from(payload))],
      ["deflate", new Uint8Array(Buffer.from(payload))],
      ["compress", new Uint8Array(Buffer.from(payload))],
      ["br, gzip", new Uint8Array(Buffer.from(payload))],
      ["gzip", gzipLookalike],
    ];
    for (const [coding, body] of cases) {
      const ctx = setup({ responseBodies: "decoded" });
      expect(ctx.protection.responseBodies).toBe("decoded");
      const { opened } = await roundTrip(
        ctx,
        ctx.client(),
        { method: "GET", target: "/api/z" },
        "raw",
        () =>
          new Response(new Uint8Array(body), {
            headers: {
              "content-encoding": coding,
              "content-length": "17",
              "content-type": "application/json",
              "x-app": "1",
            },
          }),
      );
      expect(opened?.status, coding).toBe(200);
      expect(opened?.body, coding).toEqual(body);
      expect(opened?.headers, coding).toEqual([
        ["content-type", "application/json"],
        ["x-app", "1"],
      ]);
    }
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("takes responseBodies as encoded by default and refuses any other value", () => {
    expect(setup().protection.responseBodies).toBe("encoded");
    expect(setup({ responseBodies: "encoded" }).protection.responseBodies).toBe("encoded");
    expect(() => setup({ responseBodies: "auto" as never })).toThrow(TypeError);
  });

  it("drops framing headers from the inner response", async () => {
    const ctx = setup();
    const { opened } = await roundTrip(
      ctx,
      ctx.client(),
      { method: "GET", target: "/api/z" },
      "raw",
      () => new Response("zzz", { headers: { "content-encoding": "gzip", "x-app": "1" } }),
    );
    const names = opened?.headers.map(([name]) => name) ?? [];
    expect(names).toContain("x-app");
    expect(names).not.toContain("content-encoding");
    expect(names).not.toContain("content-length");
  });
});

describe("handle: header rules", () => {
  it("never lets identity, forbidden or framing inner headers reach next", async () => {
    const ctx = setup();
    const { opened } = await roundTrip(
      ctx,
      ctx.client(),
      {
        method: "POST",
        target: "/api/h",
        headers: [
          ["cookie", "sid=inner"],
          ["origin", "https://evil.example"],
          ["host", "evil.example"],
          ["sec-fetch-site", "same-origin-inner"],
          ["sec-ch-ua", "inner"],
          ["transfer-encoding", "chunked"],
          ["content-length", "999"],
          ["connection", "close"],
          ["upgrade", "websocket"],
          ["x-forwarded-for", "1.2.3.4"],
          ["cf-connecting-ip", "1.2.3.4"],
          ["x-real-ip", "1.2.3.4"],
          ["true-client-ip", "1.2.3.4"],
          ["referer", "https://evil.example/"],
          ["accept", "application/json"],
          ["x-app", "inner"],
        ],
        body: "hello",
      },
      "raw",
    );
    const headers = new Map(json(opened).headers);
    expect(headers.get("cookie")).toBe("sid=outer");
    expect(headers.get("origin")).toBe(ORIGIN);
    expect(headers.get("sec-fetch-site")).toBe("same-origin");
    expect(headers.get("sec-fetch-mode")).toBe("cors");
    expect(headers.has("host")).toBe(false);
    expect(headers.has("sec-ch-ua")).toBe(false);
    expect(headers.has("transfer-encoding")).toBe(false);
    expect(headers.has("connection")).toBe(false);
    expect(headers.has("upgrade")).toBe(false);
    expect(headers.has("x-forwarded-for")).toBe(false);
    expect(headers.has("cf-connecting-ip")).toBe(false);
    expect(headers.has("x-real-ip")).toBe(false);
    expect(headers.has("true-client-ip")).toBe(false);
    expect(headers.has("referer")).toBe(false);
    expect(headers.get("content-length") ?? "5").toBe("5");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("x-app")).toBe("inner");
    expect(headers.get("user-agent")).toBe("outer-agent");
    const raw = ctx.seen[0];
    for (const name of [
      "cookie",
      "origin",
      "host",
      "sec-ch-ua",
      "transfer-encoding",
      "content-length",
      "connection",
      "upgrade",
    ]) {
      expect(raw.headers.get(name) ?? "", name).not.toMatch(
        /inner|evil|999|chunked|close|websocket/,
      );
    }
  });

  it("lets the outer request win for every client-address header, and for identityHeaders", async () => {
    const addressHeaders = [
      "forwarded",
      "fastly-client-ip",
      "x-client-ip",
      "x-cluster-client-ip",
      "client-ip",
      "cf-connecting-ipv6",
      "x-original-forwarded-for",
      "true-client-ip",
      "fly-client-ip",
      "x-envoy-external-address",
      "x-nf-client-connection-ip",
      "x-vercel-forwarded-for",
      "x-azure-clientip",
      "x-azure-socketip",
      "x-appengine-user-ip",
    ];
    const inner: [string, string][] = [
      ...addressHeaders.map((name): [string, string] => [name, "6.6.6.6"]),
      ["x-tenant-ip", "6.6.6.6"],
      ["x-app", "inner"],
    ];
    const outer = Object.fromEntries(
      ["fastly-client-ip", "forwarded", "x-tenant-ip"].map((name) => [name, "203.0.113.5"]),
    );

    const ctx = setup({ identityHeaders: ["X-Tenant-IP"] });
    const { opened } = await roundTrip(
      ctx,
      ctx.client(),
      { method: "POST", target: "/api/ip", headers: inner, body: "ip" },
      "raw",
      echo,
      outer,
    );
    const headers = new Map(json(opened).headers);
    for (const name of [...addressHeaders, "x-tenant-ip"]) {
      expect(headers.get(name) ?? null, name).toBe(name in outer ? "203.0.113.5" : null);
      expect(ctx.seen[0].headers.get(name) ?? "", name).not.toContain("6.6.6.6");
    }
    expect(headers.get("x-app")).toBe("inner");

    const plain = setup();
    const without = await roundTrip(
      plain,
      plain.client(),
      { method: "POST", target: "/api/ip", headers: inner, body: "ip" },
      "raw",
      echo,
      outer,
    );
    expect(new Map(json(without.opened).headers).get("x-tenant-ip")).toBe("6.6.6.6");
  });

  it("refuses identityHeaders that are not header names", () => {
    expect(() => setup({ identityHeaders: ["x ip"] })).toThrow(TypeError);
    expect(() => setup({ identityHeaders: [""] })).toThrow(TypeError);
    expect(() => setup({ identityHeaders: [1 as never] })).toThrow(TypeError);
    expect(() => setup({ identityHeaders: "x-ip" as never })).toThrow(TypeError);
  });

  it("drops inner method-override headers that name a method Fetch forbids", async () => {
    const ctx = setup();
    const { opened } = await roundTrip(
      ctx,
      ctx.client(),
      {
        method: "POST",
        target: "/api/m",
        headers: [
          ["x-http-method-override", "TRACE"],
          ["x-http-method", '"CONNECT"'],
          ["x-method-override", "patch"],
          ["x-method-override", " track"],
        ],
        body: "m",
      },
      "raw",
    );
    const headers = new Map(json(opened).headers);
    expect(headers.has("x-http-method-override")).toBe(false);
    expect(headers.has("x-http-method")).toBe(false);
    expect(headers.has("x-method-override")).toBe(false);
    for (const name of ["x-http-method-override", "x-http-method", "x-method-override"]) {
      expect(ctx.seen[0].headers.has(name), name).toBe(false);
    }

    const allowed = await roundTrip(
      ctx,
      ctx.client(),
      {
        method: "POST",
        target: "/api/m",
        headers: [
          ["x-http-method-override", "PATCH"],
          ["x-method-override", "DELETE, PUT"],
          ["x-http-method", "TRACEROUTE"],
        ],
        body: "m",
      },
      "raw",
    );
    const kept = new Map(json(allowed.opened).headers);
    expect(kept.get("x-http-method-override")).toBe("PATCH");
    expect(kept.get("x-method-override")).toBe("DELETE, PUT");
    expect(kept.get("x-http-method")).toBe("TRACEROUTE");
  });

  it("carries the outer identity headers and leaves the tunnel's Content-Type out", async () => {
    const ctx = setup();
    const { opened } = await roundTrip(
      ctx,
      ctx.client(),
      { method: "GET", target: "/api/h" },
      "json",
      echo,
      {
        "cf-connecting-ip": "203.0.113.9",
        "x-forwarded-for": "203.0.113.9",
        referer: `${ORIGIN}/page`,
      },
    );
    const headers = new Map(json(opened).headers);
    expect(headers.get("cf-connecting-ip")).toBe("203.0.113.9");
    expect(headers.get("x-forwarded-for")).toBe("203.0.113.9");
    expect(headers.get("referer")).toBe(`${ORIGIN}/page`);
    expect(headers.has("content-type")).toBe(false);
  });
});

describe("handle: the inner target", () => {
  it("cannot change the scheme or host", async () => {
    for (const target of [
      "//evil.example/api/x",
      "/\\evil.example/api/x",
      "https://evil.example/api/x",
      "http:/api/x",
    ]) {
      const ctx = setup();
      const { opened } = await roundTrip(ctx, ctx.client(), { method: "GET", target }, "raw");
      expect(opened, target).toBeNull();
      expect(ctx.seen.map((inner) => inner.url)).toEqual([TUNNEL]);
      expect(ctx.infos[0].info).toMatchObject({ sealed: false, path: "/api/k7Zq" });
      const strict = setup({ requireSealed: true });
      const refused = await roundTrip(strict, strict.client(), { method: "GET", target }, "raw");
      expect(refused.outer.status, target).toBe(REFUSAL_STATUS);
      expect(strict.seen).toEqual([]);
    }
  });

  it("keeps the outer scheme and host for every inner URL", async () => {
    const ctx = setup();
    const client = ctx.client();
    const sealed = client.sealRequest({ method: "GET", target: "/api/q?x=1" }, "raw");
    const outer = await ctx.protection.handle(
      tunnelRequest(sealed, {}, "http://localhost:8787/api/t"),
      echo,
    );
    expect(json(client.openResponse(new Uint8Array(await outer.arrayBuffer()), "raw")).url).toBe(
      "http://localhost:8787/api/q?x=1",
    );
  });

  it("must fall inside the protected routes", async () => {
    for (const target of ["/admin", "/api/../admin", "/api/%2e%2e/admin", "/api/public/x", "/"]) {
      const ctx = setup();
      const { outer } = await roundTrip(ctx, ctx.client(), { method: "GET", target }, "raw");
      expect(outer.status, target).toBe(REFUSAL_STATUS);
      expect(ctx.seen, target).toEqual([]);
      expect(ctx.infos[0].info.refusal).toBe("outside-routes");
    }
  });

  it("matches routes after decoding escapes of unreserved characters", async () => {
    for (const target of [
      "/api/%70ublic/x",
      "/api/pub%6cic/x",
      "/api/pub%6Cic/x",
      "/%61pi/public/x",
    ]) {
      const ctx = setup();
      const { outer } = await roundTrip(ctx, ctx.client(), { method: "GET", target }, "raw");
      expect(outer.status, target).toBe(REFUSAL_STATUS);
      expect(ctx.seen, target).toEqual([]);
      expect(ctx.infos[0].info.refusal).toBe("outside-routes");
    }
    const ctx = setup();
    const { opened } = await roundTrip(
      ctx,
      ctx.client(),
      { method: "GET", target: "/%61pi/items/%7E1" },
      "raw",
    );
    expect(opened?.status).toBe(200);
    expect(json(opened).url).toBe(`${ORIGIN}/%61pi/items/%7E1`);
    const plain = setup();
    const native = new Request(`${ORIGIN}/api/%70ublic/feed`);
    let seen: Request | null = null;
    await plain.protection.handle(native, (r) => {
      seen = r;
      return new Response("native");
    });
    expect(seen).toBe(native);
    expect(plain.infos).toEqual([]);
  });

  it("refuses an inner request Fetch can't build", async () => {
    for (const request of [
      { method: "GET", target: "/api/x", body: "body on a GET" },
      { method: "CONNECT", target: "/api/x" },
      { method: "TRACE", target: "/api/x" },
    ]) {
      const ctx = setup();
      const { outer } = await roundTrip(ctx, ctx.client(), request, "raw");
      expect(outer.status).toBe(REFUSAL_STATUS);
      expect(ctx.infos[0].info.refusal).toBe("bad-request");
    }
  });
});

describe("handle: cross-site requests", () => {
  it("refuses Sec-Fetch-Site cross-site and same-site", async () => {
    for (const site of ["cross-site", "same-site", "none"]) {
      const ctx = setup();
      const { outer } = await roundTrip(
        ctx,
        ctx.client(),
        { method: "POST", target: "/api/pay" },
        "raw",
        echo,
        {
          "sec-fetch-site": site,
          origin: "https://evil.example",
        },
      );
      expect(outer.status, site).toBe(REFUSAL_STATUS);
      expect(ctx.seen).toEqual([]);
      expect(ctx.infos[0].info).toMatchObject({ refusal: "cross-site", sealed: true });
    }
  });

  it("refuses a foreign Origin without Sec-Fetch-Site, and a request with neither", async () => {
    const ctx = setup();
    const client = ctx.client();
    const sealed = client.sealRequest({ method: "POST", target: "/api/pay" }, "raw");
    const foreign = tunnelRequest(sealed, { origin: "https://evil.example" });
    foreign.headers.delete("sec-fetch-site");
    expect((await ctx.protection.handle(foreign, echo)).status).toBe(REFUSAL_STATUS);
    const bare = post(TUNNEL, sealed.body);
    expect((await ctx.protection.handle(bare, echo)).status).toBe(REFUSAL_STATUS);
    expect(ctx.seen).toEqual([]);
  });

  it("accepts the page's own Origin from a browser without Fetch metadata", async () => {
    const ctx = setup({ allowedOrigins: [] });
    const sealed = ctx.client().sealRequest({ method: "GET", target: "/api/ok" }, "raw");
    const request = tunnelRequest(sealed, { origin: ORIGIN });
    request.headers.delete("sec-fetch-site");
    expect((await ctx.protection.handle(request, echo)).status).toBe(200);
    expect(ctx.seen).toEqual([]);
    expect(ctx.protection.counters.sealed).toBe(1);
  });

  it("accepts an Origin listed in allowedOrigins", async () => {
    const ctx = setup();
    const { outer } = await roundTrip(
      ctx,
      ctx.client(),
      { method: "GET", target: "/api/ok" },
      "raw",
      echo,
      {
        "sec-fetch-site": "cross-site",
        origin: "https://staging.app.example",
      },
    );
    expect(outer.status).toBe(200);
  });
});

describe("handle: plaintext", () => {
  const plainPost = () =>
    post(
      `${ORIGIN}/api/items`,
      JSON.stringify({ name: "a plaintext body long enough to look like anything at all" }),
      { "content-type": "application/json" },
    );

  it("passes plaintext through by default, body intact, marked unsealed", async () => {
    const ctx = setup();
    for (const request of [new Request(`${ORIGIN}/api/items?x=1`), plainPost()]) {
      const seen: Request[] = [];
      const response = await ctx.protection.handle(request, (r) => {
        seen.push(r);
        return echo(r);
      });
      expect(seen[0]).toBe(request);
      const body = (await response.json()) as { body: string; method: string };
      if (request.method === "POST") {
        expect(Buffer.from(body.body, "base64").toString()).toContain("plaintext body");
      }
    }
    expect(ctx.infos.map((i) => i.info.sealed)).toEqual([false, false]);
    expect(ctx.protection.counters).toMatchObject({ plaintext: 2, sealed: 0, openFailures: 0 });
  });

  it("refuses plaintext with requireSealed", async () => {
    const ctx = setup({ requireSealed: true });
    for (const request of [new Request(`${ORIGIN}/api/items`), plainPost()]) {
      const response = await ctx.protection.handle(request, echo);
      expect(response.status).toBe(REFUSAL_STATUS);
    }
    expect(ctx.infos.map((i) => i.info.refusal)).toEqual(["unsealed", "unsealed"]);
    expect(ctx.protection.counters.refusals).toBe(2);
  });

  it("passes a body that looks like base64 but fails to open through intact", async () => {
    const ctx = setup();
    for (const encoding of ENCODINGS) {
      const text = encodeOuter(nacl.randomBytes(300), encoding);
      const request = post(`${ORIGIN}/api/upload`, text);
      let received: Uint8Array | null = null;
      const response = await ctx.protection.handle(request, async (r) => {
        received = new Uint8Array(await r.arrayBuffer());
        return new Response("app saw it", { status: 404 });
      });
      expect(response.status).toBe(404);
      expect(received).toEqual(text);
    }
    expect(ctx.protection.counters.openFailures).toBe(4);
    expect(ctx.infos.every((i) => i.info.sealed === false)).toBe(true);

    const strict = setup({ requireSealed: true });
    const text = encodeOuter(nacl.randomBytes(300), "base64");
    const response = await strict.protection.handle(post(`${ORIGIN}/api/upload`, text), echo);
    expect(response.status).toBe(REFUSAL_STATUS);
    expect(strict.infos[0].info.refusal).toBe("open-failed");
  });

  it("passes a record of a socket kind through as an open failure", async () => {
    const ctx = setup();
    const client = ctx.client();
    const frame = client.socketFrame(null, "binary", true) as Uint8Array;
    const request = post(TUNNEL, frame, { "sec-fetch-site": "same-origin" });
    const response = await ctx.protection.handle(request, () => new Response("plain"));
    expect(await response.text()).toBe("plain");
    expect(ctx.protection.counters.openFailures).toBe(1);
  });

  it("leaves routes outside the protected ones untouched and unreported", async () => {
    const ctx = setup({ requireSealed: true });
    for (const url of [`${ORIGIN}/`, `${ORIGIN}/assets/app.js`, `${ORIGIN}/api/public/feed`]) {
      const request = new Request(url);
      let seen: Request | null = null;
      const response = await ctx.protection.handle(request, (r) => {
        seen = r;
        return new Response("native");
      });
      expect(seen).toBe(request);
      expect(await response.text()).toBe("native");
    }
    expect(ctx.infos).toEqual([]);
  });
});

describe("handle: body size", () => {
  it("never reads a body over the default cap or without Content-Length before next", async () => {
    for (const length of [DEFAULT_MAX_SEALED_BODY_BYTES + 1, null]) {
      const ctx = setup();
      const bytes = nacl.randomBytes(4096);
      const { stream, pulls } = countedStream(bytes, 512);
      const request = streamedPost(TUNNEL, stream, length);
      const original = request.body;
      let pulledBeforeNext = -1;
      let received: Uint8Array | null = null;
      const response = await ctx.protection.handle(request, async (r) => {
        pulledBeforeNext = pulls.bytes;
        expect(r).toBe(request);
        expect(r.body).toBe(original);
        received = new Uint8Array(await r.arrayBuffer());
        return new Response("app", { status: 201 });
      });
      expect(response.status).toBe(201);
      expect(pulledBeforeNext).toBe(0);
      expect(received).toEqual(bytes);
      expect(ctx.protection.counters).toMatchObject({ plaintext: 1, openFailures: 0 });
      expect(ctx.infos[0].info.sealed).toBe(false);
    }
  });

  it("passes a sealed record over maxSealedBodyBytes untouched, and refuses it with requireSealed", async () => {
    const ctx = setup({ maxSealedBodyBytes: 200 });
    const sealed = ctx.client().sealRequest({ method: "POST", target: "/api/big" }, "raw");
    expect(sealed.body.length).toBeGreaterThan(200);
    const request = tunnelRequest(sealed);
    const original = request.body;
    let seen: Request | null = null;
    const response = await ctx.protection.handle(request, (r) => {
      seen = r;
      return new Response("plain");
    });
    expect(await response.text()).toBe("plain");
    expect(seen).toBe(request);
    expect(request.body).toBe(original);
    expect(ctx.protection.counters).toMatchObject({ sealed: 0, plaintext: 1, openFailures: 0 });

    const strict = setup({ maxSealedBodyBytes: 200, requireSealed: true });
    const big = strict.client().sealRequest({ method: "POST", target: "/api/big" }, "base64");
    const refused = await strict.protection.handle(tunnelRequest(big), () => {
      throw new Error("next must not run");
    });
    expect(refused.status).toBe(REFUSAL_STATUS);
    expect(strict.infos[0].info).toMatchObject({ refusal: "too-large", sealed: false });

    const fits = setup({ maxSealedBodyBytes: 4096, requireSealed: true });
    const small = await roundTrip(
      fits,
      fits.client(),
      { method: "GET", target: "/api/ok" },
      "json",
    );
    expect(small.outer.status).toBe(200);
    expect(json(small.opened).url).toBe(`${ORIGIN}/api/ok`);
  });

  it("stops reading at the cap when Content-Length understates the body", async () => {
    for (const requireSealed of [false, true]) {
      const ctx = setup({ maxSealedBodyBytes: 1000, requireSealed });
      const bytes = nacl.randomBytes(5000);
      const { stream, pulls } = countedStream(bytes, 64);
      let pulledBeforeNext = -1;
      let received: Uint8Array | null = null;
      const response = await ctx.protection.handle(streamedPost(TUNNEL, stream, 100), async (r) => {
        pulledBeforeNext = pulls.bytes;
        received = new Uint8Array(await r.arrayBuffer());
        return new Response("app");
      });
      if (requireSealed) {
        expect(response.status).toBe(REFUSAL_STATUS);
        expect(ctx.infos[0].info.refusal).toBe("too-large");
        expect(pulls.bytes).toBeLessThanOrEqual(1000 + 2 * 64);
      } else {
        expect(await response.text()).toBe("app");
        expect(pulledBeforeNext).toBeLessThanOrEqual(1000 + 2 * 64);
        expect(received).toEqual(bytes);
      }
    }
  });

  it("reads a record that arrives one byte per chunk", async () => {
    const ctx = setup({ requireSealed: true });
    const sealed = ctx.client().sealRequest({ method: "GET", target: "/api/bytes" }, "raw");
    const { stream } = countedStream(new Uint8Array(sealed.body), 1);
    const response = await ctx.protection.handle(
      streamedPost(TUNNEL, stream, sealed.body.length),
      echo,
    );
    expect(response.status).toBe(200);
    expect(ctx.infos[0].info).toMatchObject({ sealed: true, path: "/api/bytes" });
  });

  it("never reads a body too short to hold a record", async () => {
    const ctx = setup({ requireSealed: true });
    const { stream, pulls } = countedStream(nacl.randomBytes(71), 71);
    const response = await ctx.protection.handle(streamedPost(TUNNEL, stream, 71), echo);
    expect(response.status).toBe(REFUSAL_STATUS);
    expect(ctx.infos[0].info.refusal).toBe("unsealed");
    expect(pulls.bytes).toBe(0);
  });
});

describe("handle: fresh sessions", () => {
  it("refuses the session one past freshSessionsPerMinute from one address", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const ctx = setup({ freshSessionsPerMinute: 3, clientAddress: byTestAddress });
    const from = (address: string) => ({ "cf-connecting-ip": address });
    const clients = [ctx.client(), ctx.client(), ctx.client(), ctx.client()];
    const statuses: number[] = [];
    for (const client of clients) {
      const { outer } = await roundTrip(
        ctx,
        client,
        { method: "GET", target: "/api/s" },
        "raw",
        echo,
        from("198.51.100.1"),
      );
      statuses.push(outer.status);
    }
    expect(statuses).toEqual([200, 200, 200, REFUSAL_STATUS]);
    expect(ctx.infos[3].info.refusal).toBe("rate-limited");

    const again = await roundTrip(
      ctx,
      clients[0],
      { method: "GET", target: "/api/s" },
      "raw",
      echo,
      from("198.51.100.1"),
    );
    expect(again.outer.status).toBe(200);
    const other = await roundTrip(
      ctx,
      ctx.client(),
      { method: "GET", target: "/api/s" },
      "raw",
      echo,
      from("198.51.100.2"),
    );
    expect(other.outer.status).toBe(200);

    vi.setSystemTime(new Date("2026-01-01T00:01:00Z"));
    const later = await roundTrip(
      ctx,
      clients[3],
      { method: "GET", target: "/api/s" },
      "raw",
      echo,
      from("198.51.100.1"),
    );
    expect(later.outer.status).toBe(200);
  });

  it("keys the session cache on eph_public with its top bit masked", async () => {
    const ctx = setup({ freshSessionsPerMinute: 1, clientAddress: byTestAddress });
    const ephSecret = nacl.randomBytes(32);
    const from = { "cf-connecting-ip": "192.0.2.7" };
    for (const topBit of [0, 1] as const) {
      const client = new Np1TestClient({ serverPublic: ctx.serverPublic, ephSecret, topBit });
      const { outer, opened } = await roundTrip(
        ctx,
        client,
        { method: "GET", target: "/api/t" },
        "raw",
        echo,
        from,
      );
      expect(outer.status).toBe(200);
      expect(json(opened).url).toBe(`${ORIGIN}/api/t`);
    }
  });

  it("counts no request under a shared empty address when clientAddress finds none", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const none of [null, undefined, ""]) {
      const ctx = setup({ freshSessionsPerMinute: 1, clientAddress: () => none });
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        const { outer } = await roundTrip(
          ctx,
          ctx.client(),
          { method: "GET", target: "/api/s" },
          "raw",
          echo,
          { "cf-connecting-ip": "198.51.100.1", "x-forwarded-for": "198.51.100.1" },
        );
        statuses.push(outer.status);
      }
      expect(statuses).toEqual([200, 200, 200, 200]);
    }
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it("refuses a plaintext body that looks like a record once the address is over the cap", async () => {
    const ctx = setup({ freshSessionsPerMinute: 1, clientAddress: () => "one" });
    const lookalike = () =>
      post(`${ORIGIN}/api/upload`, encodeOuter(nacl.randomBytes(300), "base64"));
    const app = () => new Response("app saw it", { status: 201 });
    expect((await ctx.protection.handle(lookalike(), app)).status).toBe(201);
    expect((await ctx.protection.handle(lookalike(), app)).status).toBe(REFUSAL_STATUS);
    expect(ctx.infos[1].info).toMatchObject({ refusal: "rate-limited", sealed: false });
    const plain = post(
      `${ORIGIN}/api/upload`,
      JSON.stringify({ note: "a plaintext JSON body with more than one key", n: 1 }),
    );
    expect((await ctx.protection.handle(plain, app)).status).toBe(201);
    expect(ctx.protection.counters).toMatchObject({ openFailures: 1, refusals: 1, plaintext: 2 });
  });

  it("never lets cross-site requests use up an address's sessions", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const ctx = setup({ freshSessionsPerMinute: 3, clientAddress: byTestAddress });
    const victim = { "cf-connecting-ip": "198.51.100.77" };
    const app = () => new Response("app saw it");
    for (let i = 0; i < 10; i++) {
      for (const encoding of ["base64", "raw"] as const) {
        const lookalike = post(TUNNEL, encodeOuter(nacl.randomBytes(80), encoding), {
          ...victim,
          "sec-fetch-site": "cross-site",
          "sec-fetch-mode": "no-cors",
          origin: "https://evil.example",
          "content-type": "text/plain",
        });
        await ctx.protection.handle(lookalike, app);
      }
      const sealed = ctx.client().sealRequest({ method: "POST", target: "/api/pay" }, "raw");
      const forged = tunnelRequest(sealed, {
        ...victim,
        "sec-fetch-site": "cross-site",
        origin: "https://evil.example",
      });
      expect((await ctx.protection.handle(forged, echo)).status).toBe(REFUSAL_STATUS);
    }
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const { outer } = await roundTrip(
        ctx,
        ctx.client(),
        { method: "GET", target: "/api/s" },
        "raw",
        echo,
        victim,
      );
      statuses.push(outer.status);
    }
    expect(statuses).toEqual([200, 200, 200, REFUSAL_STATUS]);
    expect(ctx.seen.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/s",
      "/api/s",
      "/api/s",
    ]);
  });

  it("takes the client address from clientAddress when given", async () => {
    const ctx = setup({ freshSessionsPerMinute: 1, clientAddress: () => "same" });
    const first = await roundTrip(
      ctx,
      ctx.client(),
      { method: "GET", target: "/api/s" },
      "raw",
      echo,
      { "cf-connecting-ip": "1.1.1.1" },
    );
    const second = await roundTrip(
      ctx,
      ctx.client(),
      { method: "GET", target: "/api/s" },
      "raw",
      echo,
      { "cf-connecting-ip": "2.2.2.2" },
    );
    expect([first.outer.status, second.outer.status]).toEqual([200, REFUSAL_STATUS]);
  });
});

describe("handle: onRequest and counters", () => {
  it("receives the inner method, path, status and the sealed flag", async () => {
    const ctx = setup();
    await roundTrip(
      ctx,
      ctx.client(),
      { method: "DELETE", target: "/api/items/9?hard=1" },
      "base64url",
      () => new Response(null, { status: 204 }),
    );
    await ctx.protection.handle(
      new Request(`${ORIGIN}/api/items`),
      () => new Response("x", { status: 201 }),
    );
    expect(ctx.infos.map((i) => i.info)).toEqual([
      {
        method: "DELETE",
        path: "/api/items/9",
        status: 204,
        sealed: true,
        durationMs: expect.any(Number),
      },
      {
        method: "GET",
        path: "/api/items",
        status: 201,
        sealed: false,
        durationMs: expect.any(Number),
      },
    ]);
    expect(ctx.infos[0].request.url).toBe(`${ORIGIN}/api/items/9?hard=1`);
    expect(ctx.protection.counters).toEqual({
      sealed: 1,
      plaintext: 1,
      openFailures: 0,
      refusals: 0,
    });
  });

  it("never lets a throwing onRequest break the response", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = setup({
      onRequest: () => {
        throw new Error("logger down");
      },
    });
    const { outer } = await roundTrip(
      ctx,
      ctx.client(),
      { method: "GET", target: "/api/x" },
      "raw",
    );
    expect(outer.status).toBe(200);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("createNetworkProtection: keys", () => {
  it("takes a pair the OS X25519 made, as afterpack network keygen prints it", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("x25519");
    const x = publicKey.export({ format: "jwk" }).x ?? "";
    const d = privateKey.export({ format: "jwk" }).d ?? "";
    const protection = createNetworkProtection({
      privateKeys: d,
      routes: { include: ["/api/**"] },
    });
    const client = new Np1TestClient({ serverPublic: base64urlToBytes(x) });
    const sealed = client.sealRequest({ method: "GET", target: "/api/os" }, "raw");
    const outer = await protection.handle(tunnelRequest(sealed), echo);
    expect(json(client.openResponse(new Uint8Array(await outer.arrayBuffer()), "raw")).url).toBe(
      `${ORIGIN}/api/os`,
    );
  });

  it("makes key pairs whose public half matches publicKeyFor", () => {
    const pair = generateKeyPair();
    expect(pair.privateKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(publicKeyFor(pair.privateKey)).toBe(pair.publicKey);
  });
});

describe("createNetworkProtection: options", () => {
  it("refuses keys and routes it can't use", () => {
    const { privateKey } = generateKeyPair();
    const routes = { include: ["/api/**"] };
    expect(() => createNetworkProtection({ privateKeys: [], routes })).toThrow(/at least one key/);
    expect(() => createNetworkProtection({ privateKeys: ["short"], routes })).toThrow(/base64url/);
    expect(() =>
      createNetworkProtection({ privateKeys: privateKey, routes: { include: [] } }),
    ).toThrow(/routes.include/);
    expect(() =>
      createNetworkProtection({ privateKeys: privateKey, routes: { include: ["api/**"] } }),
    ).toThrow(/start with/);
    expect(() =>
      createNetworkProtection({ privateKeys: privateKey, routes, freshSessionsPerMinute: -1 }),
    ).toThrow(/freshSessionsPerMinute/);
    expect(() =>
      createNetworkProtection({ privateKeys: privateKey, routes, allowedOrigins: ["nope"] }),
    ).toThrow(/allowedOrigins/);
    for (const maxSealedBodyBytes of [0, 71, 1.5, Number.NaN, 2 ** 60]) {
      expect(() =>
        createNetworkProtection({ privateKeys: privateKey, routes, maxSealedBodyBytes }),
      ).toThrow(/maxSealedBodyBytes/);
    }
    expect(() =>
      createNetworkProtection({ privateKeys: privateKey, routes, maxSealedBodyBytes: 72 }),
    ).not.toThrow();
  });

  it("names no key in its errors", () => {
    for (const secret of ["A".repeat(42), "B".repeat(44), `${"C".repeat(43)}!`]) {
      const attempt = () =>
        createNetworkProtection({ privateKeys: secret, routes: { include: ["/**"] } });
      expect(attempt).toThrow(/base64url/);
      expect(attempt).not.toThrow(secret);
    }
  });

  it("needs clientAddress for freshSessionsPerMinute, and reads no header by default", () => {
    const { privateKey } = generateKeyPair();
    const routes = { include: ["/api/**"] };
    expect(() =>
      createNetworkProtection({ privateKeys: privateKey, routes, freshSessionsPerMinute: 5 }),
    ).toThrow(/clientAddress/);
    expect(() =>
      createNetworkProtection({
        privateKeys: privateKey,
        routes,
        freshSessionsPerMinute: 5,
        clientAddress: () => "x",
      }),
    ).not.toThrow();
  });
});
