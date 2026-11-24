import {
  createNetworkProtection as createCoreProtection,
  generateKeyPair,
  type RequestInfo,
} from "@afterpack/network-core";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { describe, expect, it } from "vitest";
import { Np1TestClient } from "../../network-core/test/np1-client.js";
import {
  cloudflareClientAddress,
  createNetworkProtection,
  createSocketProtection,
  networkProtection,
  REFUSAL_STATUS,
  withNetworkProtection,
} from "../src/index.js";

const ORIGIN = "https://app.example";

interface Env {
  NETWORK_PRIVATE_KEYS: string;
}

function keys() {
  const pair = generateKeyPair();
  const serverPublic = new Uint8Array(Buffer.from(pair.publicKey, "base64url"));
  return { pair, client: () => new Np1TestClient({ serverPublic }) };
}

function tunnel(body: Uint8Array, contentType: string, path = "/api/x9"): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    body: new Uint8Array(body),
    headers: {
      "content-length": String(body.length),
      "content-type": contentType,
      "sec-fetch-site": "same-origin",
      cookie: "sid=1",
    },
  });
}

function app(infos: RequestInfo[]) {
  const hono = new Hono<{ Bindings: Env }>();
  hono.use(
    "/api/*",
    networkProtection(hono, (env: Env) => ({
      privateKeys: env.NETWORK_PRIVATE_KEYS,
      routes: { include: ["/api/**"] },
      onRequest: (_request, info) => infos.push(info),
    })),
  );
  hono.get("/api/items/:id", (c) =>
    c.json({ id: c.req.param("id"), q: c.req.query("q"), cookie: c.req.header("cookie") }),
  );
  hono.post("/api/items", async (c) => {
    const body = await c.req.json();
    c.header("set-cookie", "a=1; Path=/", { append: true });
    c.header("set-cookie", "b=2; Path=/", { append: true });
    return c.json({ created: body }, 201);
  });
  hono.get("/api/redirect", (c) => c.redirect("/api/items/1", 302));
  hono.get("/health", (c) => c.text("ok"));
  return hono;
}

describe("networkProtection: Hono middleware", () => {
  it("routes the unwrapped request through the app's own router and seals the response", async () => {
    const { pair, client } = keys();
    const infos: RequestInfo[] = [];
    const hono = app(infos);
    const env = { NETWORK_PRIVATE_KEYS: pair.privateKey };
    for (const encoding of ["raw", "base64", "base64url", "json"] as const) {
      const c = client();
      const get = c.sealRequest({ method: "GET", target: "/api/items/7?q=caf%C3%A9" }, encoding);
      const outer = await hono.fetch(tunnel(get.body, get.contentType), env);
      expect(outer.status).toBe(200);
      expect(outer.headers.get("cache-control")).toBe("no-store");
      const opened = c.openResponse(new Uint8Array(await outer.arrayBuffer()), encoding);
      expect(opened.status).toBe(200);
      expect(JSON.parse(Buffer.from(opened.body).toString())).toEqual({
        id: "7",
        q: "café",
        cookie: "sid=1",
      });
    }
    expect(infos.map((i) => [i.method, i.path, i.status, i.sealed])).toEqual([
      ["GET", "/api/items/7", 200, true],
      ["GET", "/api/items/7", 200, true],
      ["GET", "/api/items/7", 200, true],
      ["GET", "/api/items/7", 200, true],
    ]);
  });

  it("hoists Set-Cookie and keeps a redirect inside", async () => {
    const { pair, client } = keys();
    const hono = app([]);
    const env = { NETWORK_PRIVATE_KEYS: pair.privateKey };
    const c = client();
    const post = c.sealRequest(
      {
        method: "POST",
        target: "/api/items",
        headers: [["content-type", "application/json"]],
        body: '{"n":1}',
      },
      "json",
    );
    const outer = await hono.fetch(tunnel(post.body, post.contentType), env);
    expect(outer.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    const opened = c.openResponse(new Uint8Array(await outer.arrayBuffer()), "json");
    expect(opened.status).toBe(201);
    expect(JSON.parse(Buffer.from(opened.body).toString())).toEqual({ created: { n: 1 } });

    const redirect = c.sealRequest({ method: "GET", target: "/api/redirect" }, "raw");
    const hop = await hono.fetch(tunnel(redirect.body, redirect.contentType), env);
    expect(hop.status).toBe(200);
    const inner = c.openResponse(new Uint8Array(await hop.arrayBuffer()), "raw");
    expect(inner.status).toBe(302);
    expect(inner.headers).toContainEqual(["location", "/api/items/1"]);
  });

  it("passes plaintext to the matched route and leaves other routes alone", async () => {
    const { pair } = keys();
    const infos: RequestInfo[] = [];
    const hono = app(infos);
    const env = { NETWORK_PRIVATE_KEYS: pair.privateKey };
    const plain = await hono.fetch(new Request(`${ORIGIN}/api/items/3`), env);
    expect(await plain.json()).toMatchObject({ id: "3" });
    const posted = await hono.fetch(
      new Request(`${ORIGIN}/api/items`, {
        method: "POST",
        body: JSON.stringify({ plain: true }),
        headers: { "content-type": "application/json" },
      }),
      env,
    );
    expect(posted.status).toBe(201);
    expect(await posted.json()).toEqual({ created: { plain: true } });
    expect(await (await hono.fetch(new Request(`${ORIGIN}/health`), env)).text()).toBe("ok");
    expect(infos.map((i) => [i.path, i.sealed])).toEqual([
      ["/api/items/3", false],
      ["/api/items", false],
    ]);
  });

  it("refuses a cross-site tunnel request before the app sees it", async () => {
    const { pair, client } = keys();
    const hono = app([]);
    const c = client();
    const sealed = c.sealRequest({ method: "GET", target: "/api/items/1" }, "raw");
    const request = tunnel(sealed.body, sealed.contentType);
    request.headers.set("sec-fetch-site", "cross-site");
    const outer = await hono.fetch(request, { NETWORK_PRIVATE_KEYS: pair.privateKey });
    expect(outer.status).toBe(REFUSAL_STATUS);
  });

  it("seals the JSON itself when the app compresses its responses", async () => {
    const { pair, client } = keys();
    const hono = new Hono<{ Bindings: Env }>();
    hono.use(
      "/api/*",
      networkProtection(hono, (env: Env) => ({
        privateKeys: env.NETWORK_PRIVATE_KEYS,
        routes: { include: ["/api/**"] },
      })),
    );
    hono.use(compress());
    const items = Array.from({ length: 400 }, (_, i) => ({ id: i, name: `item ${i}` }));
    hono.get("/api/big", (c) => c.json({ items }));
    const env = { NETWORK_PRIVATE_KEYS: pair.privateKey };

    const plain = new Request(`${ORIGIN}/api/big`, { headers: { "accept-encoding": "gzip" } });
    expect((await hono.fetch(plain, env)).headers.get("content-encoding")).toBe("gzip");

    for (const encoding of ["raw", "json"] as const) {
      const c = client();
      const sealed = c.sealRequest({ method: "GET", target: "/api/big" }, encoding);
      const request = tunnel(sealed.body, sealed.contentType);
      request.headers.set("accept-encoding", "gzip, deflate, br");
      const outer = await hono.fetch(request, env);
      expect(outer.headers.get("content-encoding")).toBeNull();
      const opened = c.openResponse(new Uint8Array(await outer.arrayBuffer()), encoding);
      expect(opened.status).toBe(200);
      expect(opened.body.length).toBeGreaterThan(1024);
      expect(JSON.parse(Buffer.from(opened.body).toString())).toEqual({ items });
      expect(opened.headers.map(([name]) => name)).not.toContain("content-encoding");
    }
  });

  it("refuses an app that is not one", () => {
    expect(() =>
      networkProtection(null as never, { privateKeys: "x", routes: { include: ["/**"] } }),
    ).toThrow(TypeError);
  });
});

describe("freshSessionsPerMinute on Cloudflare", () => {
  it("counts by CF-Connecting-IP, the address Cloudflare sets, unless clientAddress is given", async () => {
    const { pair, client } = keys();
    const env = { NETWORK_PRIVATE_KEYS: pair.privateKey };
    const from = (address: string, spoof: string) => {
      const c = client();
      const sealed = c.sealRequest({ method: "GET", target: "/api/s" }, "raw");
      const request = tunnel(sealed.body, sealed.contentType);
      request.headers.set("cf-connecting-ip", address);
      request.headers.set("x-forwarded-for", spoof);
      request.headers.set("x-real-ip", spoof);
      return request;
    };
    const wrapped = withNetworkProtection(() => new Response("ok"), {
      privateKeys: pair.privateKey,
      routes: { include: ["/api/**"] },
      freshSessionsPerMinute: 1,
    });
    const statuses = [];
    for (const [address, spoof] of [
      ["203.0.113.1", "1.1.1.1"],
      ["203.0.113.1", "2.2.2.2"],
      ["203.0.113.2", "2.2.2.2"],
    ]) {
      statuses.push((await wrapped(from(address, spoof), env, {})).status);
    }
    expect(statuses).toEqual([200, REFUSAL_STATUS, 200]);

    const custom = createNetworkProtection({
      privateKeys: pair.privateKey,
      routes: { include: ["/api/**"] },
      freshSessionsPerMinute: 1,
      clientAddress: (request) => request.headers.get("x-real-ip"),
    });
    const next = () => new Response("ok");
    expect((await custom.handle(from("203.0.113.9", "4.4.4.4"), next)).status).toBe(200);
    expect((await custom.handle(from("203.0.113.9", "5.5.5.5"), next)).status).toBe(200);
    expect((await custom.handle(from("203.0.113.8", "5.5.5.5"), next)).status).toBe(REFUSAL_STATUS);
  });

  it("counts an IPv6 client by its /64, so rotating within it gains nothing", () => {
    const at = (address: string) =>
      cloudflareClientAddress(
        new Request(`${ORIGIN}/api/s`, { headers: { "cf-connecting-ip": address } }),
      );
    const prefix = "2001:db8:1:2::/64";
    for (const address of [
      "2001:db8:1:2::1",
      "2001:0db8:0001:0002:ffff:ffff:ffff:ffff",
      "2001:DB8:1:2:a:b:c:d",
      "2001:db8:1:2::",
      "2001:db8:1:2::7%eth0",
    ]) {
      expect(at(address), address).toBe(prefix);
    }
    expect(at("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
    expect(at("::1")).toBe("0:0:0:0::/64");
    expect(at("203.0.113.1")).toBe("203.0.113.1");
    expect(at("::ffff:203.0.113.1")).toBe("::ffff:203.0.113.1");
    expect(at("not:an:address::x")).toBe("not:an:address::x");
    expect(cloudflareClientAddress(new Request(`${ORIGIN}/api/s`))).toBeNull();
  });

  it("refuses a fresh IPv6 session from a rotated address in the same /64", async () => {
    const { pair, client } = keys();
    const protection = createNetworkProtection({
      privateKeys: pair.privateKey,
      routes: { include: ["/api/**"] },
      freshSessionsPerMinute: 1,
    });
    const from = (address: string) => {
      const sealed = client().sealRequest({ method: "GET", target: "/api/s" }, "raw");
      const request = tunnel(sealed.body, sealed.contentType);
      request.headers.set("cf-connecting-ip", address);
      return request;
    };
    const next = () => new Response("ok");
    const statuses = [];
    for (const address of ["2001:db8::1", "2001:db8::2", "2001:db8:0:1::1"]) {
      statuses.push((await protection.handle(from(address), next)).status);
    }
    expect(statuses).toEqual([200, REFUSAL_STATUS, 200]);
  });
});

describe("withNetworkProtection: a plain Worker fetch handler", () => {
  const worker = {
    seen: [] as string[],
    async fetch(request: Request, env: Env, ctx: { tag: string }) {
      this.seen.push(
        `${request.method} ${new URL(request.url).pathname} ${ctx.tag} ${env.NETWORK_PRIVATE_KEYS.length}`,
      );
      return new Response(`hello ${new URL(request.url).searchParams.get("name")}`);
    },
    async scheduled() {
      return "kept";
    },
  };

  it("wraps an exported handler object, keeping its other handlers", async () => {
    const { pair, client } = keys();
    const wrapped = withNetworkProtection(worker, (env: Env) => ({
      privateKeys: env.NETWORK_PRIVATE_KEYS,
      routes: { include: ["/api/**"] },
    }));
    const env = { NETWORK_PRIVATE_KEYS: pair.privateKey };
    const c = client();
    const sealed = c.sealRequest({ method: "GET", target: "/api/hello?name=ada" }, "base64url");
    const outer = await wrapped.fetch(tunnel(sealed.body, sealed.contentType), env, { tag: "ctx" });
    const opened = c.openResponse(new Uint8Array(await outer.arrayBuffer()), "base64url");
    expect(Buffer.from(opened.body).toString()).toBe("hello ada");
    expect(worker.seen).toEqual([`GET /api/hello ctx ${pair.privateKey.length}`]);
    expect(await wrapped.scheduled()).toBe("kept");
  });

  it("wraps a bare fetch function and builds the protection once per env", async () => {
    const { pair, client } = keys();
    let built = 0;
    const wrapped = withNetworkProtection(
      (request: Request) => new Response(new URL(request.url).pathname),
      (env: Env) => {
        built++;
        return createNetworkProtection({
          privateKeys: env.NETWORK_PRIVATE_KEYS,
          routes: { include: ["/api/**"] },
        });
      },
    );
    const env = { NETWORK_PRIVATE_KEYS: pair.privateKey };
    for (let i = 0; i < 3; i++) {
      const c = client();
      const sealed = c.sealRequest({ method: "GET", target: `/api/n${i}` }, "raw");
      const outer = await wrapped(tunnel(sealed.body, sealed.contentType), env, undefined);
      expect(
        Buffer.from(
          c.openResponse(new Uint8Array(await outer.arrayBuffer()), "raw").body,
        ).toString(),
      ).toBe(`/api/n${i}`);
    }
    expect(built).toBe(1);
  });

  it("takes plain options built once", async () => {
    const { pair } = keys();
    const wrapped = withNetworkProtection(() => new Response("plain"), {
      privateKeys: pair.privateKey,
      routes: { include: ["/api/**"] },
      requireSealed: true,
    });
    expect((await wrapped(new Request(`${ORIGIN}/api/x`), {}, {})).status).toBe(REFUSAL_STATUS);
    expect(await (await wrapped(new Request(`${ORIGIN}/page`), {}, {})).text()).toBe("plain");
  });
});

describe("Content-Encoding on Workers, where every body reads decoded", () => {
  const payload = JSON.stringify({ items: Array.from({ length: 300 }, (_, i) => `item ${i}`) });
  const proxied = (coding: string) => {
    const fetched = new Response(payload, {
      headers: {
        "content-encoding": coding,
        "content-length": "123",
        "content-type": "application/json",
      },
    });
    return new Response(fetched.body, fetched);
  };
  const codings = ["br", "zstd", "gzip", "deflate", "br, gzip", "x-unknown"];

  it("seals a proxied br body as read through the Hono middleware", async () => {
    const { pair, client } = keys();
    const hono = new Hono<{ Bindings: Env }>();
    hono.use(
      "/api/*",
      networkProtection(hono, (env: Env) => ({
        privateKeys: env.NETWORK_PRIVATE_KEYS,
        routes: { include: ["/api/**"] },
      })),
    );
    hono.get("/api/proxy/:coding", (c) => proxied(decodeURIComponent(c.req.param("coding"))));
    const env = { NETWORK_PRIVATE_KEYS: pair.privateKey };
    for (const coding of codings) {
      const c = client();
      const sealed = c.sealRequest(
        { method: "GET", target: `/api/proxy/${encodeURIComponent(coding)}` },
        "base64url",
      );
      const outer = await hono.fetch(tunnel(sealed.body, sealed.contentType), env);
      expect(outer.status, coding).toBe(200);
      expect(outer.headers.get("content-encoding"), coding).toBeNull();
      const opened = c.openResponse(new Uint8Array(await outer.arrayBuffer()), "base64url");
      expect(opened.status, coding).toBe(200);
      expect(Buffer.from(opened.body).toString(), coding).toBe(payload);
      const names = opened.headers.map(([name]) => name);
      expect(names, coding).toContain("content-type");
      expect(names, coding).not.toContain("content-encoding");
      expect(names, coding).not.toContain("content-length");
    }
  });

  it("seals a proxied br body as read through withNetworkProtection", async () => {
    const { pair, client } = keys();
    const wrapped = withNetworkProtection(
      (request: Request) => proxied(new URL(request.url).searchParams.get("coding") ?? ""),
      { privateKeys: pair.privateKey, routes: { include: ["/api/**"] } },
    );
    for (const coding of codings) {
      const c = client();
      const sealed = c.sealRequest(
        { method: "GET", target: `/api/p?coding=${encodeURIComponent(coding)}` },
        "raw",
      );
      const outer = await wrapped(tunnel(sealed.body, sealed.contentType), {}, {});
      const opened = c.openResponse(new Uint8Array(await outer.arrayBuffer()), "raw");
      expect(opened.status, coding).toBe(200);
      expect(Buffer.from(opened.body).toString(), coding).toBe(payload);
    }
  });

  it("builds every protection with decoded response bodies and refuses one that is not", async () => {
    const { pair } = keys();
    const options = { privateKeys: pair.privateKey, routes: { include: ["/api/**"] } };
    expect(createNetworkProtection(options).responseBodies).toBe("decoded");
    expect(createNetworkProtection({ ...options, responseBodies: "encoded" }).responseBodies).toBe(
      "decoded",
    );
    expect(createSocketProtection(options).protection.responseBodies).toBe("decoded");
    expect(() =>
      withNetworkProtection(() => new Response("x"), createCoreProtection(options)),
    ).toThrow(TypeError);
    const fromEnv = withNetworkProtection(
      () => new Response("x"),
      () => createCoreProtection(options),
    );
    expect(() => fromEnv(new Request(`${ORIGIN}/api/x`), {}, {})).toThrow(TypeError);
    const decoded = createCoreProtection({ ...options, responseBodies: "decoded" });
    const kept = withNetworkProtection(() => new Response("x"), decoded);
    expect(await (await kept(new Request(`${ORIGIN}/api/x`), {}, {})).text()).toBe("x");
  });
});
