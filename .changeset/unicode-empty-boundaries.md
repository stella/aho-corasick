---
"@stll/aho-corasick": patch
---

Reject empty patterns at construction and preparation with `EmptyPatternError` (`ERR_EMPTY_PATTERN`, including `patternIndex`) in the JavaScript API, and an inspectable empty-pattern index on the existing Rust error type. Empty pattern arrays remain valid. Prepared automata containing empty patterns are rejected too. This changes the previous empty-pattern behavior.

Keep string search ranges on Unicode scalar boundaries, including case-folded searches.
