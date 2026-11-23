import { generateKeyPair, type RequestInfo } from "@afterpack/network-core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { Np1TestClient } from "../../network-core/test/np1-client.js";
import {
  createNetworkProtection,
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
    headers: { "content-type": contentType, "sec-fetch-site": "same-origin", cookie: "sid=1" },
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

  it("refuses an app that is not one", () => {
    expect(() =>
      networkProtection(null as never, { privateKeys: "x", routes: { include: ["/**"] } }),
    ).toThrow(TypeError);
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
