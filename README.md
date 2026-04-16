<p align="center">
  <img src=".github/assets/banner.png" alt="Stella" width="100%" />
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

Public npm publishing is not enabled yet. The planned
package name is `@stll/aho-corasick`.

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
import { StreamMatcher } from "@stll/aho-corasick";

const sm = new StreamMatcher(["needle", "haystack"]);

for await (const chunk of readableStream) {
  const matches = sm.write(chunk);
  for (const m of matches) {
    console.log(
      `Pattern ${m.pattern} ` + `at ${m.start}..${m.end}`,
    );
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
for ASCII, Unicode, and WASM cases. Run it locally:

```bash
bun run bench:install
bun run bench:download
bun run bench:all
```

The harness compares multiple JS/TS implementations on
public corpora and verifies equal match counts across
libraries.

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

# Run tests (113 tests, including Unicode edge cases)
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
