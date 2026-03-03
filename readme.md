# [AfterPack](https://www.afterpack.dev)

High-performance JavaScript obfuscator and audit tool — find leaked secrets, seal your production code.

[www.afterpack.dev](https://www.afterpack.dev)

## Installation

```bash
npx afterpack
```

## Commands

| Command | Description |
| --- | --- |
| `npx afterpack audit <url>` | Scan a live URL for leaked secrets and sensitive data |
| `npx afterpack` | Obfuscate JavaScript build artifacts _(coming soon)_ |

## Security Audit

Scan any live frontend for leaked secrets, exposed source code, and sensitive data — powered by the [AfterPack API](https://www.afterpack.dev).

```bash
npx afterpack audit <url>
```

**Example:**

```bash
npx afterpack audit example.com
```

- **Security score** — 0-100 rating based on exposed secrets, source maps, and unprotected resources
- **Resource analysis** — counts total, unprotected, and source-exposed JavaScript files
- **Tech stack detection** — identifies frameworks and libraries in use
- **Web report** — outputs a link to the full interactive report on afterpack.dev

## Obfuscation

- **Free & Production-Ready** — Full obfuscation at no cost. Pro unlocks multi-file and edge features
- **20-70x Faster** — Rust-powered engine leaves JavaScript-based tools in the dust
- **Irreversible** — Non-linear transforms that can't be undone by deobfuscators or AI
- **Any Complexity** — From minimal to extreme protection with `--inflate`
- **Deterministic** — Same input = same output. Works with Turborepo, Nx, Bazel
- **Source Maps** — Generate and chain for Sentry/Datadog error tracking
- **Framework Presets** — Safe defaults for Next.js, Vite, Astro
- **Dual Runtime** — Native bindings + WASM for edge deployment

## License

[MIT](./LICENSE) (c) AfterPack
