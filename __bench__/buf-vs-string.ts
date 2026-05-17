/**
 * Buffer-vs-string transport benchmark.
 *
 * Asserts that `findIterBuf` stays within 2x of
 * `findIter` on the same corpus. Both APIs must use
 * the packed `Uint32Array` transport; if a future
 * change reverts `findIterBuf` to per-match FFI
 * object allocation, this benchmark fails.
 *
 * Self-contained: synthesises a haystack large
 * enough to produce ~140k matches without needing
 * an external corpus download.
 *
 * Run: bun __bench__/buf-vs-string.ts
 */
import { AhoCorasick } from "../src/index";

const SENTENCE =
  "the quick brown fox jumps over the lazy dog and " +
  "the cat watches as the sun sets over the hills, " +
  "the wind blows softly and the trees sway in the " +
  "breeze, the river flows and the world turns. ";

// Sized so `findIter` reports ~140k matches with the
// pattern set below (matches audit reference scale).
const haystack = SENTENCE.repeat(2000);
const buffer = Buffer.from(haystack);

const patterns = [
  "the",
  "and",
  "over",
  "fox",
  "cat",
  "dog",
  "sun",
  "sets",
  "wind",
  "river",
];

const ac = new AhoCorasick(patterns);

const stringMatches = ac.findIter(haystack);
const bufMatches = ac.findIterBuf(buffer);

if (stringMatches.length !== bufMatches.length) {
  console.error(
    `Match-count mismatch: findIter=${stringMatches.length} ` +
      `findIterBuf=${bufMatches.length}`,
  );
  process.exit(1);
}

const N = 10;
const WARMUP = 3;

const time = (
  name: string,
  fn: () => number,
): { ms: number; count: number } => {
  for (let i = 0; i < WARMUP; i++) fn();
  const t = performance.now();
  let count = 0;
  for (let i = 0; i < N; i++) count = fn();
  const ms = (performance.now() - t) / N;
  console.log(
    `  ${name.padEnd(20)}${ms.toFixed(2).padStart(8)} ms` +
      `   ${String(count).padStart(8)} matches`,
  );
  return { ms, count };
};

console.log("=".repeat(62));
console.log(" findIter vs findIterBuf");
console.log(
  ` haystack: ${(haystack.length / 1e6).toFixed(2)} MB, ` +
    `${patterns.length} patterns, ` +
    `${stringMatches.length} matches/run`,
);
console.log("=".repeat(62) + "\n");

const stringResult = time(
  "findIter (string)",
  () => ac.findIter(haystack).length,
);
const bufResult = time(
  "findIterBuf (buf)",
  () => ac.findIterBuf(buffer).length,
);

const ratio = bufResult.ms / stringResult.ms;
const THRESHOLD = 2;

console.log(
  `\n  findIterBuf / findIter = ${ratio.toFixed(2)}x`,
);

if (ratio > THRESHOLD) {
  console.error(
    `\nFAIL: findIterBuf is ${ratio.toFixed(2)}x ` +
      `findIter (limit ${THRESHOLD}x).`,
  );
  console.error(
    "Check that the buffer path is still routed " +
      "through the packed Uint32Array transport " +
      "(see _findIterPackedBuf in src/lib.rs and " +
      "the unpackBuf path in src/core.ts).",
  );
  process.exit(1);
}

console.log(
  `OK: findIterBuf within ${THRESHOLD}x of findIter.`,
);
