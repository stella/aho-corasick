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
//   { pattern: 0, start: 0, end: 3 },
//   { pattern: 1, start: 4, end: 7 },
//   { pattern: 2, start: 8, end: 11 },
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
  // Force DFA mode (default: false, auto NFA)
  dfa: true,
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

### Buffer API

For working with raw bytes:

```typescript
const buf = Buffer.from("hello foo world");
ac.findIterBuf(buf); // byte offsets
ac.isMatchBuf(buf); // boolean
```

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
| bible.txt (4.0 MB) | 20 legal terms | **4.1 ms** | 568 ms | 173 ms | 199 ms | 828 ms |
| E.coli (4.6 MB) | 16 DNA codons | **2.6 ms** | 741 ms | 29 ms | 222 ms | 889 ms |
| world192.txt (2.5 MB) | 20 legal terms | **2.6 ms** | 347 ms | 118 ms | 115 ms | 473 ms |
| bible.txt (4.0 MB) | 1 pattern | **2.0 ms** | 453 ms | 23 ms | 97 ms | 664 ms |

### Unicode (Leipzig Corpora Collection)

| Haystack | Patterns | @stella | modern-ahocorasick | ahocorasick | @monyone | @tanishiking |
| --- | --- | --- | --- | --- | --- | --- |
| Czech news 2024 (4.8 MB) | 10 legal terms | **15 ms** | 543 ms | 270 ms | 127 ms | 550 ms |
| Turkish news 2024 (5.4 MB) | 10 terms | **17 ms** | 639 ms | 305 ms | 270 ms | 693 ms |
| Japanese newscrawl 2019 (2.4 MB) | 10 terms | **14 ms** | 321 ms | 227 ms | 108 ms | 457 ms |
| Chinese Wikipedia 2021 (2.0 MB) | 10 terms | **10 ms** | 307 ms | 259 ms | 112 ms | 346 ms |
| German news 2024 (5.5 MB) | 10 terms | **9 ms** | 658 ms | 237 ms | 85 ms | 642 ms |

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
| `.isMatch(haystack)` | `boolean` | Any pattern matches? |
| `.findIter(haystack)` | `Match[]` | Non-overlapping matches |
| `.findOverlappingIter(haystack)` | `Match[]` | All overlapping matches |
| `.replaceAll(haystack, replacements)` | `string` | Replace matched patterns |
| `.findIterBuf(buffer)` | `Match[]` | Matches in Buffer (byte offsets) |
| `.isMatchBuf(buffer)` | `boolean` | Any match in Buffer? |
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
  dfa?: boolean;
};

type Match = {
  pattern: number; // index into patterns array
  start: number; // UTF-16 code unit offset
  end: number; // exclusive
};
```

## Limitations

- **Case insensitivity is ASCII-only.** The
  underlying Rust crate folds `A-Z` to `a-z` but
  does not handle Unicode case folding (Turkish
  `İ`/`ı`, German `ß`/`ss`, etc.). This is a
  [documented upstream limitation](https://docs.rs/aho-corasick/latest/aho_corasick/struct.AhoCorasickBuilder.html#method.ascii_case_insensitive).
- **Native dependency.** Requires a prebuilt binary
  or Rust toolchain. Not suitable for edge runtimes
  (Cloudflare Workers, Deno Deploy) where native
  modules are unsupported.

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

# Run tests (43 tests, including Unicode edge cases)
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
