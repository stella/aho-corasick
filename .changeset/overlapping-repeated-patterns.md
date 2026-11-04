---
"@stll/aho-corasick": patch
---

Overlapping search reports every index of a repeated pattern again, including patterns that repeat after case folding, as 1.x did. 2.0 kept each distinct pattern once under its first index, so `findOverlappingIter` lost the later indexes, with or without `wholeWords`. Prepared automata now carry the repeated-pattern table (format version 2); automata prepared by 2.0.1 or earlier are rejected and must be prepared again.
