<p align="center">
  <img src=".github/assets/banner.png" alt="Stella" width="100%" />
</p>

# @stella/aho-corasick

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
npm install @stella/aho-corasick
# or
bun add @stella/aho-corasick
```

Prebuilt binaries are available for:

| Platform      | Architecture |
| ------------- | ------------ |
| macOS         | x64, arm64   |
| Linux (glibc) | x64, arm64   |
| Linux (musl)  | x64          |
| Windows       | x64          |

## Usage

```typescript
import { AhoCorasick } from "@stella/aho-corasick";

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
  // ASCII case-insensitive (default: false)
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
import {
  StreamMatcher,
} from "@stella/aho-corasick";

const sm = new StreamMatcher([
  "needle",
  "haystack",
]);

for await (const chunk of readableStream) {
  const matches = sm.write(chunk);
  for (const m of matches) {
    console.log(
      `Pattern ${m.pattern} ` +
        `at ${m.start}..${m.end}`,
    );
  }
}

sm.flush(); // finalize
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

for (const [group, terms]
  of Object.entries(GROUPS)) {
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

Measured on Apple M3, 24 GB RAM, macOS 25.3.0,
Bun 1.3.10. Automaton pre-built; times are
search-only averaged over multiple runs.

Corpora:
[Canterbury Large Corpus](https://corpus.canterbury.ac.nz/)
(ASCII),
[Leipzig Corpora Collection](https://wortschatz.uni-leipzig.de/en/download/)
(Unicode).

Run locally:
`bun run bench:install && bun run bench:download && bun run bench:all`

### ASCII (Canterbury Large Corpus)

| Haystack | Patterns | @stella | modern-ahocorasick | ahocorasick | @monyone | @tanishiking |
| --- | --- | --- | --- | --- | --- | --- |
| bible.txt (4.0 MB) | 20 legal terms | **5 ms** | 444 ms | 130 ms | 129 ms | 585 ms |
| E.coli (4.6 MB) | 16 DNA codons | **2 ms** | 288 ms | 16 ms | 135 ms | 637 ms |
| world192.txt (2.5 MB) | 20 legal terms | **1 ms** | 300 ms | 121 ms | 71 ms | 312 ms |
| bible.txt (4.0 MB) | 1 pattern | **1 ms** | 254 ms | 19 ms | 53 ms | 420 ms |

### Unicode (Leipzig Corpora Collection)

| Haystack | Patterns | @stella | modern-ahocorasick | ahocorasick | @monyone | @tanishiking |
| --- | --- | --- | --- | --- | --- | --- |
| Czech news 2024 (4.8 MB) | 10 legal terms | **23 ms** | 563 ms | 271 ms | 94 ms | 652 ms |
| Turkish news 2024 (5.4 MB) | 10 terms | **28 ms** | 724 ms | 358 ms | 158 ms | 731 ms |
| Japanese newscrawl 2019 (2.4 MB) | 10 terms | **16 ms** | 521 ms | 411 ms | 168 ms | 620 ms |
| Chinese Wikipedia 2021 (2.0 MB) | 10 terms | **15 ms** | 361 ms | 323 ms | 94 ms | 607 ms |
| German news 2024 (5.5 MB) | 10 terms | **13 ms** | 742 ms | 229 ms | 107 ms | 846 ms |

### WASM (browser target)

The same Rust code compiles to WASM via
`wasm32-wasip1-threads`. Bundlers (Vite, Webpack)
auto-select the WASM build for browser targets.

| Haystack | @stella WASM | @stella native | Best pure JS |
| --- | --- | --- | --- |
| bible.txt (4.0 MB) | **34 ms** | 4 ms | 186 ms |
| Czech news (4.8 MB) | **61 ms** | 17 ms | 208 ms |

WASM is 4-8x slower than native, but 3-6x faster
than the best pure-JS alternative; in browsers
where native modules are unavailable, it is the
fastest option.

All match counts verified equal across libraries.
Match offsets are UTF-16 code unit indices,
compatible with `String.prototype.slice()`.

<details>
<summary>Alternatives tested</summary>

- [modern-ahocorasick](https://www.npmjs.com/package/modern-ahocorasick) — pure JS, ESM/CJS
- [ahocorasick](https://www.npmjs.com/package/ahocorasick) — pure JS
- [@monyone/aho-corasick](https://www.npmjs.com/package/@monyone/aho-corasick) — pure TS
- [@tanishiking/aho-corasick](https://www.npmjs.com/package/@tanishiking/aho-corasick) — pure TS

</details>

## API

### `AhoCorasick`

| Method | Returns | Description |
| --- | --- | --- |
| `new AhoCorasick(patterns, options?)` | instance | Build automaton |
| `.findIter(haystack)` | `Match[]` | Non-overlapping matches |
| `.findOverlappingIter(haystack)` | `Match[]` | All overlapping matches |
| `.isMatch(haystack)` | `boolean` | Any pattern matches? |
| `.replaceAll(haystack, replacements)` | `string` | Replace matched patterns |
| `.patternCount` | `number` | Number of patterns |

### `StreamMatcher`

| Method | Returns | Description |
| --- | --- | --- |
| `new StreamMatcher(patterns, options?)` | instance | Build streaming matcher |
| `.write(chunk)` | `Match[]` | Feed chunk, get global matches |
| `.flush()` | `Match[]` | Finalize stream |
| `.reset()` | `void` | Reset for reuse |

### Types

```typescript
type MatchKind =
  | "leftmost-first"
  | "leftmost-longest";

type Options = {
  matchKind?: MatchKind;
  caseInsensitive?: boolean;
  wholeWords?: boolean;
  dfa?: boolean;
};

type Match = {
  pattern: number; // index into patterns array
  start: number; // UTF-16 code unit offset
  end: number; // exclusive
  text: string; // matched substring
};
```

## Limitations

- **Case insensitivity is ASCII-only.** The
  underlying Rust crate folds `A-Z` to `a-z` but
  does not handle Unicode case folding (Turkish
  `İ`/`ı`, German `ß`/`ss`, etc.). This is a
  [documented upstream limitation](https://docs.rs/aho-corasick/latest/aho_corasick/struct.AhoCorasickBuilder.html#method.ascii_case_insensitive).
- **WASM requires `SharedArrayBuffer`.** Browser
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

# Run tests (80 tests, including Unicode edge cases)
bun test

# Download benchmark corpora
bun run bench:download

# Install benchmark dependencies (alternatives)
bun run bench:install

# Run benchmarks
bun run bench:speed       # Canterbury corpus
bun run bench:unicode     # Leipzig corpora
bun run bench:correctness # cross-library comparison
bun run bench:all         # all three

# Lint & format
bun run lint
bun run format
```

## License

[MIT](./LICENSE)
