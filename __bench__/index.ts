/**
 * Benchmark: @stella/aho-corasick (Rust/NAPI-RS)
 *            vs @monyone/aho-corasick (pure TS)
 *
 * Run: bun run bench
 */
import {
  AhoCorasick as MonYoneAC,
} from "@monyone/aho-corasick";

import { AhoCorasick } from "../index";

const PATTERNS = [
  "Smith",
  "Johnson",
  "Williams",
  "Brown",
  "Jones",
  "Garcia",
  "Miller",
  "Davis",
  "Rodriguez",
  "Martinez",
  "Hernandez",
  "Lopez",
  "Gonzalez",
  "Wilson",
  "Anderson",
  "Thomas",
  "Taylor",
  "Moore",
  "Jackson",
  "Martin",
];

// Generate a large haystack with scattered matches
const WORDS = [
  "the",
  "quick",
  "fox",
  "jumps",
  "over",
  "lazy",
  "dog",
  "and",
  "then",
  "runs",
  "away",
  "from",
  "big",
  "cat",
  "sat",
];

const buildHaystack = (size: number): string => {
  const parts: string[] = [];
  for (let i = 0; i < size; i++) {
    if (i % 100 === 50) {
      // Insert a match every ~100 words
      parts.push(
        PATTERNS[i % PATTERNS.length]!,
      );
    } else {
      parts.push(WORDS[i % WORDS.length]!);
    }
  }
  return parts.join(" ");
};

const haystack = buildHaystack(50_000);
console.log(
  `Haystack: ${haystack.length.toLocaleString()} chars` +
    `, ${PATTERNS.length} patterns\n`,
);

// --- @stella/aho-corasick (Rust) ---
const stellaAc = new AhoCorasick(PATTERNS);

// --- @monyone/aho-corasick (pure TS) ---
const tsAc = new MonYoneAC(PATTERNS);

const bench = (
  name: string,
  fn: () => void,
  iterations: number,
) => {
  // Warmup
  for (let i = 0; i < 3; i++) fn();

  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const elapsed = performance.now() - start;

  const avg = (elapsed / iterations).toFixed(2);

  console.log(
    `  ${name.padEnd(38)} ` +
      `${avg.padStart(8)} ms/op ` +
      `(${iterations} iterations)`,
  );

  return elapsed;
};

const N = 50;

console.log("--- findIter (full scan) ---");
const stellaFind = bench(
  "@stella/aho-corasick (Rust)",
  () => stellaAc.findIter(haystack),
  N,
);
const tsFind = bench(
  "@monyone/aho-corasick (pure TS)",
  () => {
    const results: unknown[] = [];
    for (const m of tsAc.matchInText(haystack)) {
      results.push(m);
    }
  },
  N,
);
console.log(
  `  Speedup: ${(tsFind / stellaFind).toFixed(1)}x\n`,
);

console.log("--- replaceAll ---");
const replacements = PATTERNS.map(
  (p) => `[${p.toUpperCase()}]`,
);
bench(
  "@stella/aho-corasick (Rust)",
  () => stellaAc.replaceAll(haystack, replacements),
  N,
);
console.log("  (no pure-TS equivalent)\n");

console.log("--- isMatch (early exit) ---");
bench(
  "@stella/aho-corasick (Rust)",
  () => stellaAc.isMatch(haystack),
  N,
);
bench(
  "@monyone/aho-corasick (pure TS)",
  () => tsAc.hasKeywordInText(haystack),
  N,
);
console.log(
  "  (FFI overhead dominates for early exits)\n",
);

// Verify correctness
const stellaMatches = stellaAc.findIter(haystack);
const tsMatches = [
  ...tsAc.matchInText(haystack),
];
console.log(
  `Verification: Rust found ` +
    `${stellaMatches.length} matches, ` +
    `TS found ${tsMatches.length} matches`,
);
