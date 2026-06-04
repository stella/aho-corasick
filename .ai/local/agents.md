## Repository Specifics

`@stll/aho-corasick` is a Node/Bun package backed by a Rust Aho-Corasick engine, with native and WASM package outputs.

### Commands

- `bun install`
- `bun run lint`
- `bun run typecheck`
- `bun test`
- `bun run test:props`
- `bun run test:runtime:bun`
- `bun run test:runtime:node`
- `bun run build:js`
- `bun run version:check`

### Native Package Rules

- Keep Rust engine behavior, TypeScript API types, native loader files, and WASM compatibility in sync.
- Use property tests for matcher invariants and regression tests for Unicode, offsets, streaming, and buffer/string equivalence.
- Treat generated package metadata and platform packages as public release surface; avoid speculative changes outside the requested target.
