# Changelog

All notable changes to this project will be
documented in this file.

The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-03-16

### Fixed

- `isMatch` now respects `wholeWords` option.
  Previously it bypassed the whole-word check and
  returned `true` for partial matches.
- `replaceAll` now respects `wholeWords` option.
- Fixed a bug where a short prefix pattern (e.g.
  `"P"`) could shadow a longer whole-word match
  (e.g. `"Pavel"`) at the same position. The
  engine now uses a targeted anchored fallback at
  rejected positions.
- Fixed overlapping iterator ordering: the
  fallback query no longer breaks early on
  `m.start() != start`, since overlapping matches
  are yielded by end position, not start.

### Added

- Property-based tests (fast-check) with an oracle
  that cross-checks results against a naive
  `String.indexOf` implementation.

## [0.1.1] - 2026-03-14

### Added

- `wholeWords` option for Unicode-aware word
  boundary filtering. CJK characters are always
  treated as word boundaries (CJK languages don't
  use inter-word spaces).
- `StreamMatcher` for searching across chunked
  input. Handles cross-boundary matches
  automatically.
- WASM build (`wasm32-wasip1-threads`) for browser
  targets. Bundlers auto-select via the `browser`
  field in `package.json`.
- WASM benchmarks.

### Changed

- Match offsets are now UTF-16 code units
  (compatible with `String.prototype.slice()`),
  translated from the underlying UTF-8 byte
  offsets via an incremental strategy that avoids
  full lookup table allocation.

## [0.1.0] - 2026-03-11

### Added

- Initial release.
- `AhoCorasick` class with `findIter`,
  `findOverlappingIter`, `isMatch`, `replaceAll`,
  and `patternCount`.
- `matchKind` option: `"leftmost-first"` (default)
  and `"leftmost-longest"`.
- `caseInsensitive` option (ASCII-only, matching
  the upstream Rust crate).
- `dfa` option for forcing DFA mode.
- Packed `Uint32Array` transport from Rust to JS
  for zero-allocation match unpacking.
- Prebuilt binaries for macOS (x64, arm64), Linux
  (glibc x64/arm64, musl x64), and Windows (x64).
- ESM + CJS dual exports.

[0.1.2]: https://github.com/stella/aho-corasick/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/stella/aho-corasick/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/stella/aho-corasick/releases/tag/v0.1.0
