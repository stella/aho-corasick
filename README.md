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
search-only. Each scenario averaged over multiple
runs. Corpus:
[Canterbury Large Corpus](https://corpus.canterbury.ac.nz/)
(academic benchmark).

Run locally: `bun run bench`

### Large inputs

| Haystack | Patterns | @stella | modern-ahocorasick | ahocorasick | @monyone | @tanishiking |
| --- | --- | --- | --- | --- | --- | --- |
| bible.txt (4.0 MB) | 20 legal terms | **2.1 ms** | 270 ms | 82 ms | 76 ms | 309 ms |
| E.coli (4.6 MB) | 16 DNA codons | **0.8 ms** | 217 ms | 12 ms | 105 ms | 371 ms |

### Unicode / edge cases

| Haystack | Patterns | @stella | modern-ahocorasick | ahocorasick | @monyone | @tanishiking |
| --- | --- | --- | --- | --- | --- | --- |
| Czech diacritics (29K) | 10 legal terms | **0.06 ms** | 1.53 ms | 0.16 ms | 0.25 ms | 3.01 ms |
| Emoji-heavy (32K) | 6 patterns | **0.02 ms** | 1.43 ms | 0.35 ms | 0.35 ms | 2.05 ms |
| CJK legal forms (20K) | 5 patterns | **0.07 ms** | 1.36 ms | 0.53 ms | 0.48 ms | 3.82 ms |
| Turkish İ/ı (33K) | 3 patterns | **0.05 ms** | 1.45 ms | 0.18 ms | 0.31 ms | 2.93 ms |

All match counts verified equal across libraries.
Match offsets are UTF-16 code unit indices
(compatible with `String.prototype.slice()`).

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

# Run tests (61 tests, including Unicode edge cases)
bun test

# Run benchmarks (requires Canterbury corpus)
bun run bench

# Lint & format
bun run lint
bun run format
```

## License

[MIT](./LICENSE)
