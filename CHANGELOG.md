# Changelog

## 2.0.0

### Major Changes

- [#218](https://github.com/stella/aho-corasick/pull/218) [`c9ce986`](https://github.com/stella/aho-corasick/commit/c9ce986785d7810f69c0f917de0ec63c8362b41b) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Requires Node 20.19+ / 22.13+ / 23.5+.
  Updates the WebAssembly runtime to emnapi 2.

### Minor Changes

- [#196](https://github.com/stella/aho-corasick/pull/196) [`99df219`](https://github.com/stella/aho-corasick/commit/99df21937fdd4833e78223b7dae3af9b2c09c647) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add a single-thread WebAssembly entry with explicit initialization from bytes or a URL, and an optional inline entry for synchronous initialization without I/O.

  Normalize string patterns and haystacks to Unicode scalars, retaining UTF-16 offsets in the normalized text.

### Patch Changes

- [#218](https://github.com/stella/aho-corasick/pull/218) [`c9ce986`](https://github.com/stella/aho-corasick/commit/c9ce986785d7810f69c0f917de0ec63c8362b41b) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Normalize generated WASI loaders and preserve cleanup work when scheduling fails.

## 1.1.1

### Patch Changes

- [#174](https://github.com/stella/aho-corasick/pull/174) [`c733c06`](https://github.com/stella/aho-corasick/commit/c733c06b910ceb8bf211ccd6875fbba51afbca16) Thanks [@jan-kubica](https://github.com/jan-kubica)! - License the packages under Apache-2.0 and update the published license metadata.

- [#152](https://github.com/stella/aho-corasick/pull/152) [`7f7f57f`](https://github.com/stella/aho-corasick/commit/7f7f57f3faa70a523c8f9e3db069971caab80138) Thanks [@dependabot](https://github.com/apps/dependabot)! - Update the emnapi WASM runtime and build tooling, then regenerate its loaders.

- [#185](https://github.com/stella/aho-corasick/pull/185) [`a6535f6`](https://github.com/stella/aho-corasick/commit/a6535f68a57615549b52f6fd3da199378402d4dd) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Update the napi and bon crates and the WASM runtime build tooling.

- [#209](https://github.com/stella/aho-corasick/pull/209) [`c0681f1`](https://github.com/stella/aho-corasick/commit/c0681f1af2c58c4b082bbf2aad4661142db54694) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Load the native binding with a static import so `bun build --compile` binaries can bundle it.

- [#195](https://github.com/stella/aho-corasick/pull/195) [`8738cf5`](https://github.com/stella/aho-corasick/commit/8738cf5a0b5b08a33bca5b5c8a7aea13dec90ff9) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Reject empty patterns at construction and preparation with `EmptyPatternError` (`ERR_EMPTY_PATTERN`, including `patternIndex`) in the JavaScript API, and an inspectable empty-pattern index on the existing Rust error type. Empty pattern arrays remain valid. Prepared automata containing empty patterns are rejected too. This changes the previous empty-pattern behavior.

  Keep string search ranges on Unicode scalar boundaries, including case-folded searches.

## 1.1.0

### Minor Changes

- [#101](https://github.com/stella/aho-corasick/pull/101) [`f329c0e`](https://github.com/stella/aho-corasick/commit/f329c0e3c8f9908d017a0e82c3581a2012c976f5) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add reusable prepared automata that can be serialized once and loaded for repeated searches.

### Patch Changes

- [#124](https://github.com/stella/aho-corasick/pull/124) [`009816e`](https://github.com/stella/aho-corasick/commit/009816e1888f4f535c7647d9d7ce815f58654d41) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Update dependencies and Rust quality tooling.

## 1.0.4

### Features

- Windows support: publish the
  `@stll/aho-corasick-win32-x64-msvc` native binding
  (x86_64). The loader already resolved it; the
  package now exists on the registry.

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.2] - 2026-06-04

### Changed

- Bump rust-napi-ci.yml pin to stella/.github main (#70)
- Bun deps refresh 2026-05-15 (#69)
- Route findIterBuf through packed transport (#71)
- Auto-refresh CHANGELOG.md on release (#72)
- Update deps and adopt shared tooling
- Sync shared ai prompts (#75)
- Update dependencies (#76)
- Bump the actions group across 1 directory with 2 updates (#63)
- Refresh shared tooling and AI setup (#77)

### Fixed

- Pass --no-verify to bun install in provenance-nightly (#68)
- Improve large dictionary matching performance (#78)

## [1.0.1] - 2026-05-13

### Added

- Add post-build WASM browser compat check (#55)

### Changed

- Refresh stable lockfile integrities (#54)
- Migrate publish step to npm-publish-hardened + bun --no-verify (#66)
- Cut v1.0.1 (#67)

## [1.0.0] - 2026-04-18

### Changed

- Init
- Simplify MIT copyright notice
- Correct license holder casing (#50)
- [codex] cut aho-corasick 1.0.0 (#53)

### Fixed

- Restore nightly provenance updater (#49)

[1.0.2]: https://github.com/stella/aho-corasick/compare/v1.0.1..v1.0.2
[1.0.1]: https://github.com/stella/aho-corasick/compare/v1.0.0..v1.0.1
[1.0.0]: https://github.com/stella/aho-corasick/compare/v1.0.0-rc.1..v1.0.0

<!-- generated by git-cliff -->
