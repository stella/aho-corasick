# @stella/aho-corasick

NAPI-RS bindings to the Rust
[aho-corasick](https://docs.rs/aho-corasick/latest)
crate for Node.js and Bun.

Multi-pattern string searching in linear time. Built on
[BurntSushi's aho-corasick](https://github.com/BurntSushi/aho-corasick),
the same engine that powers `ripgrep`.

## Install

```bash
npm install @stella/aho-corasick
# or
bun add @stella/aho-corasick
```

Prebuilt binaries are available for:

| Platform        | Architecture |
| --------------- | ------------ |
| macOS           | x64, arm64   |
| Linux (glibc)   | x64, arm64   |
| Linux (musl)    | x64          |
| Windows         | x64          |

## Usage

```typescript
import { AhoCorasick } from "@stella/aho-corasick";

const ac = new AhoCorasick(
  ["foo", "bar", "baz"],
);

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

For processing large files or streams chunk by chunk:

```typescript
import { StreamMatcher } from "@stella/aho-corasick";

const sm = new StreamMatcher(["needle", "haystack"]);

for await (const chunk of readableStream) {
  const matches = sm.write(chunk);
  for (const m of matches) {
    console.log(
      `Pattern ${m.pattern} at ${m.start}..${m.end}`,
    );
  }
}

sm.flush(); // finalize
sm.reset(); // reuse for another stream
```

`StreamMatcher` automatically handles overlap between
chunks so that matches spanning chunk boundaries are
found.

### Buffer API

For working with raw bytes:

```typescript
const buf = Buffer.from("hello foo world");
ac.findIterBuf(buf);  // byte offsets
ac.isMatchBuf(buf);   // boolean
```

## API

### `AhoCorasick`

| Method                          | Returns    | Description                        |
| ------------------------------- | ---------- | ---------------------------------- |
| `new AhoCorasick(patterns, options?)` | instance | Build automaton                |
| `.isMatch(haystack)`            | `boolean`  | Any pattern matches?               |
| `.findIter(haystack)`           | `Match[]`  | Non-overlapping matches            |
| `.findOverlappingIter(haystack)` | `Match[]` | All overlapping matches            |
| `.replaceAll(haystack, replacements)` | `string` | Replace matched patterns       |
| `.findIterBuf(buffer)`          | `Match[]`  | Matches in Buffer (byte offsets)   |
| `.isMatchBuf(buffer)`           | `boolean`  | Any match in Buffer?               |
| `.patternCount`                 | `number`   | Number of patterns                 |

### `StreamMatcher`

| Method                          | Returns    | Description                        |
| ------------------------------- | ---------- | ---------------------------------- |
| `new StreamMatcher(patterns, options?)` | instance | Build streaming matcher      |
| `.write(chunk)`                 | `Match[]`  | Feed chunk, get global matches     |
| `.flush()`                      | `Match[]`  | Finalize stream                    |
| `.reset()`                      | `void`     | Reset for reuse                    |

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
  start: number;   // character offset (string API)
                   // or byte offset (buffer API)
  end: number;     // exclusive
};
```

## Why?

The JS ecosystem has no production-quality bindings to
the Rust Aho-Corasick crate. Python has
[ahocorasick-rs](https://github.com/BurntSushi/aho-corasick-python)
by BurntSushi himself; JavaScript has nothing comparable.

Pure-JS implementations like `@monyone/aho-corasick`
work but are significantly slower. This package brings
the same Rust performance to Node.js and Bun.

## Development

```bash
# Install dependencies
bun install

# Build native module (requires Rust toolchain)
bun run build

# Run tests
bun test

# Run benchmark
bun run bench

# Lint & format
bun run lint
bun run format
```

## License

[MIT](./LICENSE)
