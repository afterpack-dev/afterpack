# @afterpack/network-core

The server side of [AfterPack](https://www.afterpack.dev) network protection: NP1, the protocol that
seals an app's API and WebSocket traffic, on web-standard `Request` and `Response`.

This package is in development and not yet published. It holds the NP1 test vectors and the
cryptographic primitives they are built on; the request handler and the socket functions follow.

## Cryptography

NP1 is NaCl's `box` construction and nothing else: X25519 ([RFC 7748](https://www.rfc-editor.org/rfc/rfc7748))
for the session secret, HSalsa20 over it with 16 zero bytes for the session key
(`crypto_box_beforenm`), and XSalsa20-Poly1305 (`secretbox`) for every record. The primitives come
from the audited [`@noble/curves`](https://github.com/paulmillr/noble-curves) and
[`@noble/ciphers`](https://github.com/paulmillr/noble-ciphers), its only dependencies.

## Test vectors

`vectors/np1.json` is the contract every NP1 implementation passes, client or server.
`vectors/np1.schema.json` describes the file, and its `description` states the byte layout and the
receiving rules in full. Every vector carries its intermediate values in hex (secrets, public keys,
shared secret, session key, nonce, inner plaintext with a field-by-field layout, record and outer
body) next to the decoded fields, so a new implementation can be debugged byte by byte.

They cover:

- the RFC 7748 X25519 vectors and the NaCl `box` and `secretbox` known answers;
- session keys, with the ephemeral public key's top bit set and clear;
- records of all seven kinds in their directions;
- every outer body encoding (raw bytes, base64url, base64, a one-key JSON object) and padding to a
  bucket ladder;
- both socket frame types, with the ephemeral public key on the first client frame;
- refusals: a bad tag, an all-zero shared secret, truncation, a kind in the wrong direction or on
  the wrong transport, an unknown version or kind, malformed fields and bad encodings.

```js
import vectors from "@afterpack/network-core/vectors/np1.json" with { type: "json" };
```

The vectors are generated deterministically by `pnpm vectors` in this package. `pnpm test` fails when
the committed file differs from a fresh generation.

## License

Apache-2.0.

## Feedback

Questions, suggestions and bug reports: [afterpack.dev/contact](https://www.afterpack.dev/contact).
You can also file a bug on [GitHub Issues](https://github.com/afterpack-dev/afterpack/issues).
