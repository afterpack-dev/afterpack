# @afterpack/network-cloudflare

## Read this first: your edge loses sight of the API

Behind the tunnel, every protected call reaches your Worker as `POST` to one tunnel path, with an
encrypted body. **Cloudflare WAF custom rules and rate-limiting rules keyed on an API path, and any
rule that reads the request body, now see only that `POST`.** Move them into the Worker, keyed on the
unwrapped request: the middleware hands the real request to your routes, and `onRequest` reports its
method, path, status, timing and whether it was sealed. Your app's own authentication and validation
stay the authority.

## What it is

[AfterPack](https://www.afterpack.dev) network protection on Cloudflare: Hono middleware, a wrapper
for a plain Worker `fetch` handler, and a Durable Object socket helper. It builds on
[`@afterpack/network-core`](https://github.com/afterpack-dev/afterpack/tree/main/packages/network-core), whose README documents the NP1 protocol.

## Install

```sh
npm install @afterpack/network-cloudflare
npx afterpack network init
npx wrangler secret put NETWORK_PRIVATE_KEYS
```

`afterpack network init` makes a key pair, writes the public key into `afterpack.json` and prints the
private key once, for the secret. Until an afterpack release accepts the `network` keys in
`afterpack.json`, it writes nothing and prints the block to add instead. During a rotation the secret holds both private keys, new first,
separated by a comma.

## Hono

```js
import { Hono } from "hono";
import { networkProtection } from "@afterpack/network-cloudflare";

const app = new Hono();

app.use(
  "/api/*",
  networkProtection(app, (env) => ({
    privateKeys: env.NETWORK_PRIVATE_KEYS,
    routes: { include: ["/api/**"] },
    allowedOrigins: ["https://staging.example.com"],
  })),
);

app.get("/api/items/:id", (c) => c.json({ id: c.req.param("id") }));

export default app;
```

Pass the top-level app: the middleware routes the unwrapped request through `app.fetch`, so it
reaches the route its real method and path name, and middleware mounted before it sees the tunnel
`POST`. Plaintext requests continue down the chain unchanged.

## A plain Worker

```js
import { withNetworkProtection } from "@afterpack/network-cloudflare";

const worker = {
  async fetch(request, env, ctx) {
    return new Response("hello");
  },
};

export default withNetworkProtection(worker, (env) => ({
  privateKeys: env.NETWORK_PRIVATE_KEYS,
  routes: { include: ["/api/**"] },
}));
```

It also takes a bare `fetch(request, env, ctx)` function. The protection is built once per `env`.
The options are those of `createNetworkProtection` in `@afterpack/network-core`, or a function of
`env` that returns them. Here `clientAddress`, which `freshSessionsPerMinute` counts by, defaults to
`CF-Connecting-IP`, the address Cloudflare sets and a client can't. This package's own
`createNetworkProtection` applies the same default.

## Durable Object sockets

```js
import { createSocketProtection } from "@afterpack/network-cloudflare";

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.sockets = createSocketProtection({ privateKeys: env.NETWORK_PRIVATE_KEYS });
    for (const socket of ctx.getWebSockets()) this.sockets.restore(socket);
  }

  async fetch(request) {
    if (request.headers.get("origin") !== "https://example.com") {
      return new Response(null, { status: 403 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    this.sockets.accept(server, { seat: 1 }, request);
    this.sockets.send(server, "welcome");
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket, data) {
    const message = this.sockets.receive(socket, data);
    if (message === null) return;
    this.sockets.send(socket, `echo ${message}`);
  }
}
```

- `accept(socket, attachment?, request?)` starts the session. The session state (the key and the
  frame type) is kept in the socket's attachment with `serializeAttachment`, so a hibernated object
  resumes. Pass the upgrade request so `freshSessionsPerMinute` counts the socket's first frame
  under its `CF-Connecting-IP`; without it, sockets are not limited, and the first one logs a
  warning when the cap is set. The cap counts per helper, so in a Durable Object per object, not
  across your Worker. Read
  and write your own attachment data through `attachment(socket)` and `setAttachment(socket, value)`,
  not `serializeAttachment` directly.
- `receive(socket, data)` returns the app's message (a string or an `ArrayBuffer`), or `null` for the
  handshake record and for a frame it refuses, after closing the socket with code 1008.
- `send(socket, message)` seals and sends. Sends made before the client's first frame are buffered
  and flushed when it arrives; more than 256 of them, or more than 1 MiB, close the socket with code
  1008. A send to a socket the helper never accepted or has closed is dropped.
- A socket that sends no first frame within 10 seconds is closed with code 1008. The timer lives in
  memory, so after the object restarts, call `restore(socket)` for each of `ctx.getWebSockets()`:
  it re-arms the deadline kept in the attachment, or closes the socket if it has passed. Without it,
  a socket that never sends stays open until it does.
- **Check `Origin` on the upgrade request.** A browser sends cross-site WebSocket upgrades with the
  page's cookies and no CORS check, and anyone can seal a handshake, because the server key is
  public. The helper does not check it, so the check is yours, as for any socket.
- Close reasons travel in clear: close a protected socket with numeric codes, never prose.

## License

Apache-2.0.

## Feedback

Questions, suggestions and bug reports: [afterpack.dev/contact](https://www.afterpack.dev/contact).
You can also file a bug on [GitHub Issues](https://github.com/afterpack-dev/afterpack/issues).
