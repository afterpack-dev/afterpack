import { generateKeyPairSync } from "node:crypto";
import nacl from "tweetnacl";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNetworkProtection,
  generateKeyPair,
  publicKeyFor,
  REFUSAL_STATUS,
} from "../src/index.js";
import {
  base64urlToBytes,
  echo,
  json,
  ORIGIN,
  roundTrip,
  setup,
  TUNNEL,
  tunnelRequest,
} from "./harness.js";
import { decodeOuter, type Encoding, encodeOuter, Np1TestClient } from "./np1-client.js";

const ENCODINGS: Encoding[] = ["raw", "base64", "base64url", "json"];
const utf8 = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");

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
    const ctx = setup({ freshSessionsPerMinute: 1 });
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
    const bare = new Request(TUNNEL, { method: "POST", body: new Uint8Array(sealed.body) });
    expect((await ctx.protection.handle(bare, echo)).status).toBe(REFUSAL_STATUS);
    expect(ctx.seen).toEqual([]);
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
    new Request(`${ORIGIN}/api/items`, {
      method: "POST",
      body: JSON.stringify({ name: "a plaintext body long enough to look like anything at all" }),
      headers: { "content-type": "application/json" },
    });

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
      const request = new Request(`${ORIGIN}/api/upload`, {
        method: "POST",
        body: new Uint8Array(text),
      });
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
    const response = await strict.protection.handle(
      new Request(`${ORIGIN}/api/upload`, { method: "POST", body: new Uint8Array(text) }),
      echo,
    );
    expect(response.status).toBe(REFUSAL_STATUS);
    expect(strict.infos[0].info.refusal).toBe("open-failed");
  });

  it("passes a record of a socket kind through as an open failure", async () => {
    const ctx = setup();
    const client = ctx.client();
    const frame = client.socketFrame(null, "binary", true) as Uint8Array;
    const request = new Request(TUNNEL, {
      method: "POST",
      body: new Uint8Array(frame),
      headers: { "sec-fetch-site": "same-origin" },
    });
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

describe("handle: fresh sessions", () => {
  it("refuses the session one past freshSessionsPerMinute from one address", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const ctx = setup({ freshSessionsPerMinute: 3 });
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
    const ctx = setup({ freshSessionsPerMinute: 1 });
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
  });

  it("names no key in its errors", () => {
    const secret = "A".repeat(42);
    try {
      createNetworkProtection({ privateKeys: secret, routes: { include: ["/**"] } });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});
