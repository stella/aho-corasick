/**
 * Property-based tests for @stll/aho-corasick.
 *
 * These verify general algebraic invariants of the
 * API contract, not specific test cases. fast-check
 * generates thousands of random inputs to stress
 * these properties.
 *
 * Run manually: bun test __test__/properties.spec.ts
 * NOT run in CI (too slow for the default matrix).
 */
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { AhoCorasick } from "../lib";

// Limit runs to keep it under 30s
const PARAMS = { numRuns: 200 };

// Generate non-empty patterns (AC rejects empty)
const pattern = fc.string({ minLength: 1, maxLength: 20 });
const patterns = fc.array(pattern, {
  minLength: 1,
  maxLength: 50,
});
const haystack = fc.string({
  minLength: 0,
  maxLength: 500,
});

// ─── Property 1: text field correctness ───────

describe("property: text field", () => {
  test("slice(start, end) === text for every match", () => {
    fc.assert(
      fc.property(patterns, haystack, (pats, hay) => {
        const ac = new AhoCorasick(pats);
        const matches = ac.findIter(hay);
        for (const m of matches) {
          expect(hay.slice(m.start, m.end)).toBe(
            m.text,
          );
        }
      }),
      PARAMS,
    );
  });

  test("text field matches a pattern (case-sensitive)", () => {
    fc.assert(
      fc.property(patterns, haystack, (pats, hay) => {
        const ac = new AhoCorasick(pats);
        const matches = ac.findIter(hay);
        const patSet = new Set(pats);
        for (const m of matches) {
          expect(patSet.has(m.text)).toBe(true);
        }
      }),
      PARAMS,
    );
  });

  test("text field matches a pattern (case-insensitive)", () => {
    fc.assert(
      fc.property(patterns, haystack, (pats, hay) => {
        const ac = new AhoCorasick(pats, {
          caseInsensitive: true,
        });
        const matches = ac.findIter(hay);
        const patSetLower = new Set(
          pats.map((p) => p.toLowerCase()),
        );
        for (const m of matches) {
          expect(
            patSetLower.has(m.text.toLowerCase()),
          ).toBe(true);
        }
      }),
      PARAMS,
    );
  });
});

// ─── Property 2: non-overlapping ──────────────

describe("property: non-overlapping", () => {
  test("no two matches overlap in findIter", () => {
    fc.assert(
      fc.property(patterns, haystack, (pats, hay) => {
        const ac = new AhoCorasick(pats);
        const matches = ac.findIter(hay);
        for (let i = 1; i < matches.length; i++) {
          expect(
            matches[i]!.start,
          ).toBeGreaterThanOrEqual(
            matches[i - 1]!.end,
          );
        }
      }),
      PARAMS,
    );
  });
});

// ─── Property 3: monotonic offsets ────────────

describe("property: monotonic offsets", () => {
  test("matches are in ascending start order", () => {
    fc.assert(
      fc.property(patterns, haystack, (pats, hay) => {
        const ac = new AhoCorasick(pats);
        const matches = ac.findIter(hay);
        for (let i = 1; i < matches.length; i++) {
          expect(
            matches[i]!.start,
          ).toBeGreaterThan(matches[i - 1]!.start);
        }
      }),
      PARAMS,
    );
  });

  test("start < end for every match", () => {
    fc.assert(
      fc.property(patterns, haystack, (pats, hay) => {
        const ac = new AhoCorasick(pats);
        const matches = ac.findIter(hay);
        for (const m of matches) {
          expect(m.end).toBeGreaterThan(m.start);
        }
      }),
      PARAMS,
    );
  });
});

// ─── Property 4: wholeWords contract ──────────

const isWordChar = (ch: string) =>
  /\p{L}|\p{N}/u.test(ch);

describe("property: wholeWords boundaries", () => {
  test("every wholeWords match is at word boundaries", () => {
    fc.assert(
      fc.property(patterns, haystack, (pats, hay) => {
        const ac = new AhoCorasick(pats, {
          wholeWords: true,
        });
        const matches = ac.findIter(hay);
        for (const m of matches) {
          const before = hay[m.start - 1];
          const after = hay[m.end];
          if (before) {
            // Either non-word char before, or
            // CJK (always passes)
            expect(
              !isWordChar(before) ||
                /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(
                  m.text[0]!,
                ),
            ).toBe(true);
          }
          if (after) {
            expect(
              !isWordChar(after) ||
                /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(
                  m.text.at(-1)!,
                ),
            ).toBe(true);
          }
        }
      }),
      PARAMS,
    );
  });
});

// ─── Property 5: subset relationship ──────────

describe("property: findIter ⊆ findOverlappingIter", () => {
  test("every findIter match exists in overlapping results", () => {
    fc.assert(
      fc.property(patterns, haystack, (pats, hay) => {
        const ac = new AhoCorasick(pats);
        const nonOverlap = ac.findIter(hay);
        const overlap = ac.findOverlappingIter(hay);

        const overlapSet = new Set(
          overlap.map(
            (m) => `${m.start}:${m.end}:${m.pattern}`,
          ),
        );

        for (const m of nonOverlap) {
          expect(
            overlapSet.has(
              `${m.start}:${m.end}:${m.pattern}`,
            ),
          ).toBe(true);
        }
      }),
      PARAMS,
    );
  });
});

// ─── Property 6: wholeWords bug regression ────
//
// This is the property that would have caught the
// "P shadows Pavel" bug WITHOUT knowing about it.

describe("property: wholeWords finds isolated patterns", () => {
  test("pattern surrounded by spaces is always found", () => {
    fc.assert(
      fc.property(
        // Generate 2-50 patterns, some may share
        // prefixes (which triggers the bug)
        fc.array(
          fc.string({
            minLength: 1,
            maxLength: 10,
          }),
          { minLength: 2, maxLength: 50 },
        ),
        // Pick one pattern to verify
        fc.nat(),
        (pats, idx) => {
          const uniquePats = [...new Set(pats)];
          if (uniquePats.length === 0) return;
          const target =
            uniquePats[idx % uniquePats.length]!;

          // Put the target pattern surrounded by
          // spaces — it MUST be found as a whole word
          const hay = `xxx ${target} yyy`;
          const ac = new AhoCorasick(uniquePats, {
            wholeWords: true,
          });
          const matches = ac.findIter(hay);
          const found = matches.map((m) => m.text);

          // The target pattern (or a longer pattern
          // containing it at the same position) must
          // appear in results
          const targetFound = matches.some(
            (m) =>
              m.start <= 4 &&
              m.end >= 4 + target.length,
          );
          expect(targetFound).toBe(true);
        },
      ),
      PARAMS,
    );
  });
});
