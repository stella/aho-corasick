# stella-aho-corasick-core

Rust-native exact multi-pattern search used by
[`@stll/aho-corasick`](https://www.npmjs.com/package/@stll/aho-corasick).
It provides prepared automata, streaming matching, UTF-16 or byte offsets,
Unicode-aware word boundaries, and simple Unicode case folding.

## Example

```rust
use stella_aho_corasick_core::{AhoCorasick, Options};

let search = AhoCorasick::new(
    vec![String::from("contract"), String::from("clause")],
    Options::default(),
)?;

assert!(search.is_match("contract review")?);

# Ok::<(), stella_aho_corasick_core::Error>(())
```

The JavaScript package remains the primary distribution for Node.js, Bun, and
WASM consumers. This crate is the reusable Rust core and contains no N-API
bindings.

## License

MIT
