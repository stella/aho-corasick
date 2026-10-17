---
"@stll/aho-corasick": patch
"@stll/aho-corasick-wasm": patch
---

Reject empty patterns at construction and preparation with `EmptyPatternError` (`ERR_EMPTY_PATTERN`, including `patternIndex`) in the JavaScript API, and `Error::EmptyPattern` in the Rust core. Empty pattern arrays remain valid. Prepared automata containing empty patterns are rejected too. This changes the previous empty-pattern behavior.

Keep string search ranges on Unicode scalar boundaries, including case-folded searches.
