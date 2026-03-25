# Contributing

Thank you for your interest in contributing to
`@stll/aho-corasick`.

## CLA

All contributors must sign the
[Contributor License Agreement](https://github.com/stella/cla/blob/main/CLA.md).
You will be prompted automatically when you open
a pull request.

## Architecture

The package uses a two-layer publishing model:

- **Umbrella package** (`@stll/aho-corasick`): ships
  `dist/` (JS/TS) and `index.js` (napi native loader).
  Platform-specific binaries are installed via
  `optionalDependencies`.
- **Sub-packages** (`npm/*/`): one per target platform.
  Native sub-packages contain a `.node` binary; the
  `wasm32-wasi` sub-package contains the `.wasm` binary
  plus JS glue files and depends on `@napi-rs/wasm-runtime`.

CI builds each target in parallel, `napi artifacts` copies
binaries into the corresponding `npm/` sub-package, and
the publish job pushes all packages to npm.

## Development setup

```bash
# Prerequisites: Rust toolchain, Bun
bun install
bun run build       # native module (.node)
bun run build:wasm  # WASM module (.wasm)
bun run build:js    # TypeScript -> dist/
bun test            # run tests
bun run lint        # oxlint
bun run format      # oxfmt + rustfmt
```

To test the WASM build locally, copy the artifacts into
the sub-package:

```bash
cp aho-corasick.wasm npm/wasm32-wasi/aho-corasick.wasm32-wasi.wasm
cp aho-corasick.wasi.cjs npm/wasm32-wasi/
cp aho-corasick.wasi-browser.js npm/wasm32-wasi/
cp wasi-worker.mjs npm/wasm32-wasi/
cp wasi-worker-browser.mjs npm/wasm32-wasi/
```

## Pull requests

- One logical change per PR.
- Include tests for bug fixes and new features.
- Run `bun test && bun run lint && bun run format`
  before submitting.
- Use [Conventional Commits](https://www.conventionalcommits.org/):
  `feat:`, `fix:`, `chore:`, `docs:`.
- Squash merge is enforced; keep the PR title clean.

## Benchmarks

If your change affects performance, include
benchmark results:

```bash
bun run bench:install   # one-time
bun run bench:download  # one-time
bun run bench:all
```

## Reporting issues

Open a [GitHub issue](https://github.com/stella/aho-corasick/issues).
For security vulnerabilities, see
[SECURITY.md](./SECURITY.md).
