<p align="center">
  <img src=".github/assets/banner.png" alt="stella" width="100%" />
</p>

# @stll/aho-corasick

[NAPI-RS](https://napi.rs/) bindings to the Rust
[aho-corasick](https://github.com/BurntSushi/aho-corasick)
crate for Node.js and Bun.

Multi-pattern string searching in linear time.
Built on
[BurntSushi's aho-corasick](https://github.com/BurntSushi/aho-corasick)
(the same engine that powers
[ripgrep](https://github.com/BurntSushi/ripgrep)),
exposed to JavaScript via
[NAPI-RS](https://github.com/napi-rs/napi-rs).

## Install

```bash
npm install @stll/aho-corasick
# or
bun add @stll/aho-corasick
```

The companion `@stll/aho-corasick-wasm` package is
available for browser builds.

If you use the browser package with Vite, import the
bundled plugin so the generated WASM loader is not
pre-bundled into broken asset URLs:

```typescript
import { defineConfig } from "vite";

import stllAhoCorasickWasm from "@stll/aho-corasick-wasm/vite";

export default defineConfig({
  plugins: [stllAhoCorasickWasm()],
});
```

Prebuilts are available for:

| Platform      | Architecture |
| ------------- | ------------ |
| macOS         | x64, arm64   |
| Linux (glibc) | x64, arm64   |
| WASM          | browser      |

### Single-thread browser and WebView entry

`@stll/aho-corasick-wasm/single-thread` loads a separate
`wasm32-unknown-unknown` build of the shared Rust core. It requires neither
`SharedArrayBuffer`, a worker, nor COOP/COEP headers. Import has no fetch or
WebAssembly allocation; initialization is explicit. Matcher construction and
all search methods are synchronous after initialization. Patterns, haystacks,
and replacement strings use Unicode scalars; offsets index the normalized
well-formed string in UTF-16 code units.

Bulk byte inputs copy directly into WASM linear memory; strings encode into
that memory without JSON or numeric-array expansion. Request storage grows
with the encoded input size and is reused across calls. Matcher state,
case-fold mappings, and returned matches require their own memory.

The default entry requires caller-supplied bytes or a URL. It never chooses
an asset URL automatically:

```ts
import { AhoCorasick, init } from "@stll/aho-corasick-wasm/single-thread";

// Copy the exported single-thread/wasm asset into your extension's assets.
await init(chrome.runtime.getURL("assets/aho-corasick.single-thread.wasm"));
const matcher = new AhoCorasick(["foo", "bar"]);
matcher.findIter("foo bar");
```

`init(url)` fetches bytes and calls `WebAssembly.instantiate`; it does not
require a WASM MIME type. `init(request)` accepts a caller-supplied `Request`;
`init(response)` consumes an existing successful `Response` without fetching.
These inputs and byte buffers can come from another realm. Byte inputs include
`ArrayBuffer` and its views (including `Buffer` and `DataView`); only the view's
byte range is used. `init(bytes)` performs no I/O. For bytes already
available to an injected script, `initSync(bytes)` performs no I/O and returns
immediately. The asset is exported as
`@stll/aho-corasick-wasm/single-thread/wasm` for bundlers or copying.

For a self-contained bundle, opt into the inline entry:

```ts
import {
  AhoCorasick,
  initSync,
} from "@stll/aho-corasick-wasm/single-thread/inline";

initSync(); // Decode embedded base64 and instantiate synchronously; no fetch.
new AhoCorasick(["clipboard", "highlight"]).isMatch("clipboard");
```

Inline import also defers decoding and memory allocation until `initSync()`.
Base64 adds `4 * ceil(wasmBytes / 3) - wasmBytes` bytes before compression,
approximately 33%. Every build measures raw, base64, and gzip sizes, prints
them in the build log, and includes the exact values in
`wasm/dist/single-thread-size.json`. URL loading avoids adding those base64
bytes to the JavaScript bundle. The package includes both options.

Neither entry uses `eval`, `new Function`, blob URLs, or worker startup. CSP
still governs WebAssembly compilation: Chromium-based extension pages and
WebViews generally need `script-src 'self' 'wasm-unsafe-eval'`. A literal
`script-src 'self'` policy that forbids WASM compilation cannot run this or any
other compiling WASM loader. Tauri can bundle the raw asset and pass bytes or
its permitted asset URL without cross-origin isolation; configure its WebView
CSP to allow WebAssembly. Caller URL loading must also be allowed by
`connect-src` and the platform's asset permissions. Inline initialization
needs no network permission.

The original package entry retains its threaded loader. Both entries share
the public API, including prepared automata, named patterns, buffer search,
and streaming; initializing one entry does not rebind the other's classes.

## Usage

```typescript
import { AhoCorasick } from "@stll/aho-corasick";

const ac = new AhoCorasick(["foo", "bar", "baz"]);

// Check for any match
ac.isMatch("hello foo world"); // true

// Find all non-overlapping matches
ac.findIter("foo bar baz");
// [
//   { pattern: 0, start: 0, end: 3, text: "foo" },
//   { pattern: 1, start: 4, end: 7, text: "bar" },
//   { pattern: 2, start: 8, end: 11, text: "baz" },
// ]

// Find overlapping matches
ac.findOverlappingIter("foobar");

// Replace matches
ac.replaceAll("foo bar", ["FOO", "BAR", "BAZ"]);
// "FOO BAR"
```

### Options

```typescript
const ac = new AhoCorasick(patterns, {
  // Match semantics (default: "leftmost-first")
  matchKind: "leftmost-longest",
  // Unicode simple case folding (default: false)
  caseInsensitive: true,
  // Only match whole words (default: false)
  // Unicode-aware; CJK always passes
  wholeWords: true,
});
```

### Streaming

For processing large files or streams chunk by
chunk:

```typescript
import { StreamMatcher } from "@stll/aho-corasick";

const sm = new StreamMatcher(["needle", "haystack"]);

for await (const chunk of readableStream) {
  const matches = sm.write(chunk);
  for (const m of matches) {
    console.log(`Pattern ${m.pattern} ` + `at ${m.start}..${m.end}`);
  }
}

sm.flush(); // finalize stream state
sm.reset(); // reuse for another stream
```

`StreamMatcher` automatically handles overlap
between chunks so that matches spanning chunk
boundaries are found.

### Groups

To organize patterns into named groups (e.g., for
entity recognition), use the `pattern` index as a
lookup key into a parallel array:

```typescript
const GROUPS = {
  LEGAL_FORM: ["s.r.o.", "GmbH", "LLC"],
  CURRENCY: ["EUR", "USD", "CZK"],
};

const patterns: string[] = [];
const tag: string[] = [];

for (const [group, terms] of Object.entries(GROUPS)) {
  for (const term of terms) {
    patterns.push(term);
    tag.push(group);
  }
}

const ac = new AhoCorasick(patterns, {
  wholeWords: true,
});

for (const m of ac.findIter(text)) {
  console.log(m.text, tag[m.pattern]);
  // "GmbH" "LEGAL_FORM"
  // "EUR"  "CURRENCY"
}
```

`tag[m.pattern]` is a single array index lookup
(O(1), no hashing).

## Benchmarks

The repository includes a checked-in benchmark harness
for ASCII, Unicode, and WASM cases. The inputs are
public and the scripts are reproducible from the
repo. Run it locally:

```bash
bun run bench:download
bun run bench:all
```

The harness compares multiple JS/TS implementations on
public corpora and verifies equal match counts across
libraries. The speed suite is anchored in the
many-pattern exact-search workloads where
Aho-Corasick is meant to win, rather than single-call
toy regex cases.

Representative baseline from the checked-in public
harness on this machine:

- runtime: Bun `1.3.12`
- platform: macOS `26.4.1` (`Darwin arm64`)

| Scenario                             | `@stll/aho-corasick` | Best compared JS/TS result | Relative |
| ------------------------------------ | -------------------- | -------------------------- | -------- |
| `bible.txt`, `4.0 MB`, `20` terms    | `2.27 ms`            | `69.25 ms`                 | `30.5x`  |
| `world192.txt`, `2.5 MB`, `20` terms | `1.55 ms`            | `41.88 ms`                 | `26.9x`  |
| `E.coli`, `4.6 MB`, `16` codons      | `0.83 ms`            | `11.00 ms`                 | `13.3x`  |
| `bible.txt`, single-pattern baseline | `0.67 ms`            | `20.10 ms`                 | `29.9x`  |

<details>
<summary>Alternatives tested</summary>

- [modern-ahocorasick](https://www.npmjs.com/package/modern-ahocorasick) — pure JS, ESM/CJS
- [ahocorasick](https://www.npmjs.com/package/ahocorasick) — pure JS
- [@monyone/aho-corasick](https://www.npmjs.com/package/@monyone/aho-corasick) — pure TS
- [@tanishiking/aho-corasick](https://www.npmjs.com/package/@tanishiking/aho-corasick) — pure TS

</details>

## API

### `AhoCorasick`

| Method                                | Returns       | Description                                         |
| ------------------------------------- | ------------- | --------------------------------------------------- |
| `new AhoCorasick(patterns, options?)` | instance      | Build automaton                                     |
| `.findIter(haystack)`                 | `Match[]`     | Non-overlapping matches                             |
| `.findOverlappingIter(haystack)`      | `Match[]`     | All overlapping matches                             |
| `.isMatch(haystack)`                  | `boolean`     | Any pattern matches?                                |
| `.replaceAll(haystack, replacements)` | `string`      | Replace matched patterns                            |
| `.findIterBuf(haystack)`              | `ByteMatch[]` | Matches in a `Buffer` / `Uint8Array` (byte offsets) |
| `.isMatchBuf(haystack)`               | `boolean`     | Any pattern matches in a `Buffer` / `Uint8Array`?   |
| `.patternCount`                       | `number`      | Number of patterns                                  |

### `StreamMatcher`

| Method                                  | Returns       | Description                                |
| --------------------------------------- | ------------- | ------------------------------------------ |
| `new StreamMatcher(patterns, options?)` | instance      | Build streaming matcher                    |
| `.write(chunk)`                         | `ByteMatch[]` | Feed chunk, get global byte-offset matches |
| `.flush()`                              | `ByteMatch[]` | Finalize stream                            |
| `.reset()`                              | `void`        | Reset for reuse                            |

### Types

```typescript
type MatchKind = "leftmost-first" | "leftmost-longest";

type Options = {
  matchKind?: MatchKind;
  caseInsensitive?: boolean;
  wholeWords?: boolean;
  dfa?: boolean;
};

// Returned by string methods (findIter, etc.)
type Match = {
  pattern: number; // index into patterns array
  start: number; // UTF-16 code unit offset
  end: number; // exclusive
  text: string; // matched substring
};

// Returned by Buffer/streaming methods
type ByteMatch = {
  pattern: number; // index into patterns array
  start: number; // byte offset
  end: number; // exclusive
};
```

### Error handling

- `new AhoCorasick([...])` throws if the
  automaton cannot be built (e.g. patterns exceed
  internal size limits).
- `replaceAll(haystack, replacements)` throws if
  `replacements.length !== patternCount`.
- Empty patterns arrays are valid; all search
  methods return no matches.
- Empty pattern strings are invalid: construction, `prepare`, and
  `StreamMatcher` throw the exported `EmptyPatternError`, a `RangeError`
  with `code === "ERR_EMPTY_PATTERN"` and a zero-based `patternIndex`.
  Named empty patterns and prepared automata containing empty patterns
  are rejected too. The Rust core uses its existing `Error::BuildAutomaton` variant;
  `error.empty_pattern_index()` returns the rejected input index.
  direct NAPI bindings report `InvalidArg` with an `ERR_EMPTY_PATTERN`
  message. Native and browser APIs use the same validation.

## Limitations

- **Case insensitivity uses Unicode simple case
  folding, not locale-specific collation.** It
  handles one-to-one folds like Turkish `İ -> i`
  and `ẞ -> ß`, but it does not perform full
  multi-character expansions such as `ß -> ss`.
- **The default threaded WASM entry requires `SharedArrayBuffer`.** Browser
  builds need `Cross-Origin-Opener-Policy: same-origin`
  and `Cross-Origin-Embedder-Policy: require-corp`
  headers. Edge runtimes without WASM support
  (some Cloudflare Workers configurations) are
  not supported.

## Acknowledgements

This package is a thin binding layer. The hard work
is done by:

- [**aho-corasick**](https://github.com/BurntSushi/aho-corasick)
  by Andrew Gallant (BurntSushi) — the Rust
  implementation of the Aho-Corasick algorithm.
  MIT licensed.
- [**NAPI-RS**](https://github.com/napi-rs/napi-rs)
  — the Rust framework for building Node.js native
  addons. MIT licensed.

## Development

```bash
# Install dependencies
bun install

# Build native module (requires Rust toolchain)
bun run build

# Run tests (113 tests, including Unicode edge cases)
bun test

# Download benchmark corpora
bun run bench:download

# Run benchmarks
bun run bench:speed       # Canterbury corpus
bun run bench:unicode     # Leipzig corpora
bun run bench:correctness # cross-library comparison
bun run bench:all         # all three

# Lint & format
bun run lint
bun run format
```

Run `bun run typecheck` to check types with `bun check --no-pretty --all --project=tsconfig.json`.
Run `bun run check:typecheck-parity` to compare repository diagnostics and seeded diagnostic classes with TypeScript; CI runs both checks.
Editors continue to use the TypeScript language service because Bun has no language server.
The `typescript` dependency also supports declaration generation through tsdown.

## License

[Apache-2.0](./LICENSE)
