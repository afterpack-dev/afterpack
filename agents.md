# AfterPack CLI

> `npx afterpack` — High-performance JavaScript obfuscator

This is the **public CLI wrapper** for AfterPack. It provides a user-friendly interface to the native Rust obfuscation engine.

---

## Quick Reference

| Item | Value |
|------|-------|
| NPM Package | `afterpack` |
| CLI Command | `npx afterpack <file.js>` |
| Core Package | `@afterpack/core` (native Rust binary) |
| Repository | github.com/afterpack-dev/afterpack |
| Visibility | PUBLIC |

---

## Architecture

This repo is a **thin wrapper** around `@afterpack/core`:

```
User runs: npx afterpack dist/app.js
                │
                ▼
┌────────────────────────────────────────────────┐
│  afterpack (this package)                       │
│  • Parses CLI arguments                         │
│  • Validates input files                        │
│  • Provides user-friendly output                │
│  • Handles --help, --version, errors            │
└─────────────────────┬──────────────────────────┘
                      │ calls native functions
                      ▼
┌────────────────────────────────────────────────┐
│  @afterpack/core                                │
│  • Native Rust binary via napi-rs               │
│  • processFile() - processes JS files           │
│  • version() - returns version string           │
└────────────────────────────────────────────────┘
```

**Why this separation?**
- This repo is PUBLIC — accepts community issues/PRs
- Contains NO sensitive code — just CLI UX
- The Rust source code stays private in the `platform` repo

---

## Repository Structure

```
afterpack/
├── src/
│   ├── cli.ts           # Main CLI implementation
│   └── cli.test.ts      # Colocated tests (next to source)
├── dist/                # Compiled output (generated)
├── package.json         # Depends on @afterpack/core
├── agents.md            # This file
└── .github/workflows/
    └── ci.yml           # CI + auto-publish workflow
```

## Conventions

- **TypeScript everywhere** — No plain JavaScript files
- **Colocated tests** — Test files live next to source files (`*.test.ts`)
- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)
  - Format: `<type>(<scope>): <description>`
  - Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`
  - Examples: `feat(cli): add --verbose flag`, `fix(cli): handle spaces in paths`

---

## Development

```bash
# Install dependencies (requires @afterpack/core to be published)
npm install

# Build
npm run build

# Run development mode (watch)
npm run dev

# Run tests
npm test
```

### Local Development with Platform Repo

When developing both repos together:

```bash
# In platform repo: build and pack the core package
cd ../platform/packages/core
pnpm build
pnpm pack

# In afterpack repo: install local tarball
cd ../../afterpack
npm install ../platform/packages/core/afterpack-core-*.tgz
npm run build

# Test the CLI
node dist/cli.js --help
```

---

## CI/CD

The workflow (`.github/workflows/ci.yml`) does two things:

1. **On push/PR:** Run tests on Node 20/22 across Linux, macOS, Windows
2. **On repository_dispatch:** Auto-update when `@afterpack/core` is published
   - Triggered by platform repo's release workflow
   - Updates dependency, runs tests, and publishes new version

---

## For Full Project Context

This is a thin wrapper. For full project documentation:

**→ See [platform/agents.md](https://github.com/afterpack-dev/platform/blob/main/agents.md)**

The platform repo contains:
- Rust obfuscation engine source code
- `@afterpack/core` npm package build system
- Pro API (Cloudflare Workers)
- Infrastructure (D1 database, etc.)

---

## Key Files

| File | Purpose |
|------|---------|
| `src/cli.ts` | CLI implementation - parse args, call @afterpack/core |
| `src/cli.test.ts` | Colocated E2E tests for CLI behavior |
| `package.json` | npm config, depends on @afterpack/core |
| `.github/workflows/ci.yml` | CI and auto-publish workflow |
