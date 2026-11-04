---
"@stll/aho-corasick": patch
---

The WebAssembly packages depend on `@napi-rs/wasm-runtime` 1.2.6, the release that matches `@emnapi/core` 2.0.0-beta.2. With 1.2.5, the worker threads of the threaded WebAssembly build failed to start, so importing `@stll/aho-corasick-wasm` in a browser threw `Worker sent an unknown error`.
