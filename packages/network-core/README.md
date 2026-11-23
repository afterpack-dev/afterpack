# @afterpack/network-core

## Read this first: your edge loses sight of the API

Behind the tunnel, every protected call reaches your server as `POST` to one tunnel path, with an
encrypted body. **An edge WAF's path and body rules, and any rate limit keyed on an API path in
front of this handler, now see only that `POST`.** Move those rules into your handler, keyed on the
unwrapped request: `handle` passes the real request to `next`, and `onRequest` reports its method,
path, status, timing and whether it was sealed. Your app's own authentication and validation stay the
authority; the tunnel is not authentication.

## What it is

The server side of [AfterPack](https://www.afterpack.dev) network protection: NP1, the protocol that
seals an app's API and WebSocket traffic, on web-standard `Request` and `Response`. It runs on any
fetch-style server (Deno, Bun, Node 18+, Cloudflare Workers). On Cloudflare, use
[`@afterpack/network-cloudflare`](https://github.com/afterpack-dev/afterpack/tree/main/packages/network-cloudflare), which wraps it.

## Install

```sh
npm install @afterpack/network-core
```

Make a key pair with `npx afterpack network keygen` (or `afterpack network init`, which also writes
the public key into `afterpack.json`). The public key goes into the build config as
`network.publicKey`; the private key goes only into your server's secret store. Until an afterpack
release accepts the `network` keys in `afterpack.json`, `init` writes nothing and prints the block to
add, because a file holding them would fail every build.

## Use

```js
import { createNetworkProtection } from "@afterpack/network-core";

const protection = createNetworkProtection({
  privateKeys: process.env.NETWORK_PRIVATE_KEYS,
  routes: { include: ["/api/**"] },
  allowedOrigins: ["https://staging.example.com"],
  onRequest: (request, info) => console.log(info.method, info.path, info.status, info.sealed),
});

export default {
  fetch: (request) => protection.handle(request, (unwrapped) => app.fetch(unwrapped)),
};
```

Create the protection once per process or isolate: it holds the session cache's counters and the
fresh-session limiter.

### `createNetworkProtection(options)`

| Option | Meaning |
|---|---|
| `privateKeys` | One or more X25519 private keys, base64url (32 bytes each) or `Uint8Array`. A string may hold several, separated by commas or whitespace. The server tries each one. |
| `routes` | `{ include, exclude? }`: path globs (`*` within a segment, `**` across segments), the same as the build's `network.routes`. Percent-escapes of unreserved characters (`%70` for `p`) are decoded before matching. Requests outside them pass to `next` untouched. |
| `allowedOrigins` | Origins, besides the page's own, whose tunnel requests are accepted (`Origin` header match). Default none. |
| `requireSealed` | Refuse plaintext on the protected routes. Default `false`. |
| `freshSessionsPerMinute` | Cap on new sessions (new client keys, each costing one X25519) per client address per minute, for tunnel requests and for sockets whose first frame comes with an address. Needs `clientAddress`. Default no cap. |
| `maxSealedBodyBytes` | The largest tunnel body `handle` reads, in bytes. Default 1 MiB (`DEFAULT_MAX_SEALED_BODY_BYTES`). A `POST` whose `Content-Length` is larger, or whose body turns out larger, is never buffered: it goes to `next` untouched as plaintext, or gets the refusal status with `requireSealed`. Raise it if a protected route takes larger bodies; a sealed body is the app's body plus headers, padded up to the next 64 KiB step past 64 KiB, and a third larger in a text encoding. |
| `clientAddress(request)` | The address `freshSessionsPerMinute` counts by. No default, because only your platform knows which address it vouches for. A header a client can set itself, such as `X-Forwarded-For` or `X-Real-IP` on a server reached directly, lets any client rotate it past the cap; return such a header only when a proxy you run overwrites it. A request it returns no address for (`null`, `undefined` or `""`) is not limited, and the first one logs a warning. On Cloudflare, `@afterpack/network-cloudflare` uses `CF-Connecting-IP`. |
| `onRequest(request, info)` | Called once per request on a protected route, after the response is made. `info` is `{ method, path, status, sealed, durationMs, refusal? }`; `request` is the unwrapped request. |

It returns:

- `handle(request, next)`: unwraps a tunnel request, calls `next` with the real request and seals
  its response; passes plaintext to `next` unchanged (unless `requireSealed`).
- `openSocket(state, frame, address?)` and `sealSocket(state, message)`: the WebSocket side, pure
  functions over a small JSON-serialisable `state` (`{ key, frameType }`) you keep with the socket.
  Pass `null` as the state for the first client frame, and the client address you took from the
  upgrade request with `clientAddress(request)`, so `freshSessionsPerMinute` counts the socket.
  `openSocket` returns `{ ok: true, state, message }` (the message is `null` for a handshake record)
  or `{ ok: false, error, state }`, where `error` is an NP1 error or `rate-limited`; close the socket
  on a refusal, with a numeric code and no reason text.
- `clientAddress(request)`: the address `freshSessionsPerMinute` counts `request` under, or `null`
  when the cap is off or the option gives none. Keep it with the socket for its first frame.
- `counters`: `{ sealed, plaintext, openFailures, refusals }` since the protection was created.

### What `handle` does

- **Tunnel requests.** A `POST` on a protected route, with a `Content-Length` of at most
  `maxSealedBodyBytes`, whose body opens as an NP1 client record. Browsers send `Content-Length` for
  every buffered body, so a body without one (a streamed upload) is plaintext and is never buffered;
  nor is any body shorter than a record (72 bytes). The real request is built from it: scheme and host from the outer request; path and query from the
  inner target, which must fall inside `routes`; method, headers and body from inside.
- **Headers.** The app's inner headers plus the outer request's browser-set headers. The outer request
  wins for every header a page can't set, that carries identity, or that frames the request: the
  Fetch standard's forbidden request headers, `Cookie`, `Origin`, `Host`, `Referer`, `Sec-*`,
  `Proxy-*`, `cf-*`, `X-Forwarded-*`, `X-Real-IP`, `True-Client-IP`, `Forwarded`, and `Connection`,
  `Upgrade`, `Transfer-Encoding`, `Content-Length`, `TE`, `Trailer`, `Keep-Alive`, `Expect`. An inner
  header with one of those names is dropped, and so is an inner `X-HTTP-Method`,
  `X-HTTP-Method-Override` or `X-Method-Override` that names `CONNECT`, `TRACE` or `TRACK`, as Fetch
  forbids. The outer `Content-Type` describes the tunnel body and
  is never passed on; for every other name the inner value wins.
- **Same origin only.** A tunnel request is accepted when `Sec-Fetch-Site` is `same-origin`, or its
  `Origin` is in `allowedOrigins`. Anyone can seal a record, because the server key is public; without
  this check the tunnel would turn the app's preflighted JSON calls into simple cross-site `POST`s.
  This stops browser CSRF only.
- **Responses.** The outer response is `200` with `Cache-Control: no-store`, the request's
  `Content-Type` and the sealed record in the request's encoding. The real status, headers and body
  travel inside; `Set-Cookie` values are read with `getSetCookie()` and appended to the outer response
  one by one, because a browser stores cookies only from it. An inner `3xx` is returned untouched.
  `Content-Encoding` and the framing headers are not sealed, because the sealed body is the decoded
  one.
- **Refusals** get status `400` and a plain `Bad Request` body: a cross-site tunnel request, a target
  outside `routes`, an inner request Fetch can't build (a `GET` with a body, `CONNECT`), a client
  address over `freshSessionsPerMinute`, and, with `requireSealed`, plaintext, a body over
  `maxSealedBodyBytes` or a body that fails to open. The client runtime treats a refusal as a dropped session and retries once with a fresh one.
- **Errors in `next`.** When `next` throws or its body fails to read on a sealed request, the error
  goes to `console.error` and the client gets a sealed `500` with no headers and no body, so nothing
  about it shows on the wire. `onRequest` reports status `500`.
- **Plaintext** is accepted by default, so local development, the previous build during a rollout,
  and streamed calls keep working. A body that looks sealed but fails to open is passed through to
  `next` with its body intact and counted as an open failure. `onRequest` marks each call sealed or
  not, so production can alert on plaintext.
- **Lookalikes and the session cap.** The cap is checked before the open, on every body that looks
  like a record: a `POST` body of 72 bytes or more that is not UTF-8, base64 or base64url text, or a
  one-property JSON object whose value is such text. With `freshSessionsPerMinute` set, a plaintext
  body of that shape counts as a new session, costs one X25519, and past the cap gets the refusal
  status even without `requireSealed`. If a protected route takes such plaintext bodies, set the cap
  high enough for them, or leave it off and rate-limit in the handler.
- **Cost.** One X25519 per new client session, cached per isolate by the client's public key (an LRU
  of 4096 sessions). Opening and sealing a record is microseconds for API-sized bodies.

## NP1, for auditors

NP1 is NaCl's `box` construction and nothing else. The primitives come from the audited
[`@noble/curves`](https://github.com/paulmillr/noble-curves) (X25519) and
[`@noble/ciphers`](https://github.com/paulmillr/noble-ciphers) (HSalsa20, XSalsa20-Poly1305), this
package's only dependencies. `vectors/np1.json` is the contract every implementation passes, client
or server; `vectors/np1.schema.json` describes it.

### Keys

- The server holds one static X25519 key pair per deployment (several during a rotation). No key id
  travels: the server tries each private key.
- The client makes an ephemeral X25519 pair per page session (HTTP) or per socket. It sets the top bit
  of its encoded public key at random; X25519 masks that bit on decode
  ([RFC 7748](https://www.rfc-editor.org/rfc/rfc7748)), and the server's cache keys on the masked
  value.
- `shared = X25519(secret, peer_public)`. An all-zero result (a low-order public key) is refused.
- `key = HSalsa20(shared, 16 zero bytes)`, as `crypto_box_beforenm`. One key serves both directions;
  the kind byte names the direction, so a record can't be reflected back to its sender.

### Records

```
record = nonce(24) ‖ tag(16) ‖ ciphertext          XSalsa20-Poly1305, NaCl secretbox_easy
wire   = eph_public(32) ‖ record                    every HTTP client record, and a socket's first client frame
wire   = record                                     everywhere else
```

Every record has a fresh random 24-byte nonce. The plaintext `inner` is:

```
inner = version(0x01) ‖ kind(1 byte) ‖ fields ‖ padding
```

| Kind | Name | Direction | Transport | Fields |
|---|---|---|---|---|
| 1 | http-request | client → server | HTTP | method `string`, target `string`, `headers`, body `bytes` |
| 2 | http-response | server → client | HTTP | status `uint`, `headers`, body `bytes` |
| 3 | socket-client-text | client → server | socket | text `string` |
| 4 | socket-client-binary | client → server | socket | payload `bytes` |
| 5 | socket-server-text | server → client | socket | text `string` |
| 6 | socket-server-binary | server → client | socket | payload `bytes` |
| 7 | socket-handshake | client → server | socket | none |

Field types:

- `uint`: unsigned LEB128, at most 5 bytes, value at most `0xFFFFFFFF`, minimal form (a multi-byte
  value's last byte is not `0x00`).
- `bytes`: `uint` length, then that many bytes. `string`: `bytes` holding UTF-8; receivers are fatal
  on invalid UTF-8 and keep a leading U+FEFF. Senders write a lone surrogate as U+FFFD.
- `headers`: `uint` count, then that many (name `string`, value `string`) pairs, in order; a name may
  repeat and receivers append each pair. Names are lowercase RFC 9110 tokens. A value is a header
  ByteString (U+0000 to U+00FF) written as UTF-8; a code point above U+00FF, NUL, CR or LF is
  malformed. An http-response carries no `set-cookie` pair.
- `method`: a non-empty RFC 9110 token. `target`: bytes `0x21` to `0x7E` except `#`, starting with
  `/` and not with `//` or `/\`, so a target can never carry a scheme or host. `status`: 200 to 599.

Padding: senders append `0x00` bytes until `inner`, version and kind included, reaches the smallest
bucket of a ladder at or above its unpadded length. The ladder with ratio `r` is `ceil(256 · rⁱ)`
while below 65536, then every multiple of 65536. Clients use `r` = 1.5 or 2 per build; this server
uses `r` = 2 (256, 512, …, 32768, then 64 KiB steps). Receivers ignore padding bytes and never check
their length.

### Outer encodings

A client record travels as the body of a `POST`, in one of four encodings the build picks:

- `raw`: the wire bytes;
- `base64`: RFC 4648 §4 with `=` padding;
- `base64url`: RFC 4648 §5 without padding;
- `json`: exactly `{"<key>":"<base64url of wire>"}`, no whitespace, with a per-build key.

Text must be canonical: re-encoding the decoded bytes gives the same text. The server detects the
encoding from the body alone, never from `Content-Type`:

1. UTF-8 JSON for an object with exactly one property whose value is a string is `json`; the string
   is decoded as text below;
2. otherwise, a body whose every byte is in `A–Z a–z 0–9 + / = - _` is text: `base64` if it has that
   form, else `base64url`; text in both forms (alphanumeric, length a multiple of 4) decodes the same
   and counts as `base64url`;
3. anything else is `raw`.

The server answers in the detected encoding, with the request's JSON key and `Content-Type`.

### Sockets

The socket URL and close frames stay visible. A binary frame carries the wire bytes; a text frame
carries canonical base64url only. The server takes the frame type from the first client frame and
uses it for its own; a frame of the other type is refused. The first client frame is
`eph_public ‖ record` holding kind 7 (handshake) or the app's first message (kind 3 or 4); kind 7
anywhere else is refused. The server buffers its own sends until that frame arrives, and closes a
socket that sends none within 10 seconds.

### Receiving

A receiver checks in this order and stops at the first failure, with one of a closed set of errors:
`bad-encoding` (the body or frame doesn't decode), `truncated` (wire shorter than prefix + 40),
`zero-shared`, `open-failed` (no key opens the box), `malformed` (inner shorter than 2 bytes),
`unsupported-version`, `unknown-kind`, `wrong-direction`, `wrong-transport`, `unexpected-handshake`,
then `malformed` (the fields).

### What it does not do

- No forgery protection: anyone can seal a request to the public key. Server-side validation stays
  the only authority.
- No replay protection: a captured sealed request can be sent again, as a plaintext one can.
- Sizes are padded to a bucket, not hidden: a 40 KB response still stands out from 200 B ones.

## Test vectors

`vectors/np1.json` covers the RFC 7748 X25519 vectors and the NaCl `box` and `secretbox` known
answers, session keys with the top bit set and clear, records of all seven kinds, every outer
encoding, both padding ladders, both socket frame types, key rotation, and every refusal. Every
vector carries its intermediate values in hex, so a new implementation can be debugged byte by
byte.

```js
import vectors from "@afterpack/network-core/vectors/np1.json" with { type: "json" };
```

`pnpm vectors` regenerates them deterministically; `pnpm test` fails when the committed file differs
from a fresh generation, and checks this package and an independent client against every vector.

## License

Apache-2.0.

## Feedback

Questions, suggestions and bug reports: [afterpack.dev/contact](https://www.afterpack.dev/contact).
You can also file a bug on [GitHub Issues](https://github.com/afterpack-dev/afterpack/issues).
