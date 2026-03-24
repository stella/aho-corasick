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

import { AhoCorasick } from "../src/index";

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
          expect(hay.slice(m.start, m.end)).toBe(m.text);
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
          expect(matches[i]!.start).toBeGreaterThanOrEqual(
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
          expect(matches[i]!.start).toBeGreaterThan(
            matches[i - 1]!.start,
          );
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

const isWordChar = (ch: string) => /\p{L}|\p{N}/u.test(ch);

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

// ─── Property 6: oracle test ──────────────────
//
// The oracle is a trivially correct but slow
// implementation: overlapping search → filter by
// wholeWords → sort → greedy non-overlapping.
// Compare against findIter (fast but complex).
// Any disagreement is a bug in the fast path.

const isCjkJS = (ch: string) =>
  /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(
    ch,
  );

// Match Rust: is_alphanumeric() && !is_cjk()
const isWordCharJS = (ch: string) =>
  /\p{L}|\p{N}/u.test(ch) && !isCjkJS(ch);

function isWholeWordJS(
  hay: string,
  start: number,
  end: number,
): boolean {
  const before = hay[start - 1];
  const after = hay[end];
  const matchStart = hay[start];
  const matchEnd = hay[end - 1];

  const startOk =
    !before ||
    !isWordCharJS(before) ||
    (matchStart ? isCjkJS(matchStart) : false);
  const endOk =
    !after ||
    !isWordCharJS(after) ||
    (matchEnd ? isCjkJS(matchEnd) : false);

  return startOk && endOk;
}

/** Oracle: slow but correct wholeWords search. */
function oracleWholeWords(
  ac: InstanceType<typeof AhoCorasick>,
  hay: string,
) {
  // Step 1: all overlapping matches
  const all = ac.findOverlappingIter(hay);

  // Step 2: filter by word boundaries
  const filtered = all.filter((m) =>
    isWholeWordJS(hay, m.start, m.end),
  );

  // Step 3: sort by start, then longest first
  filtered.sort((a, b) =>
    a.start !== b.start
      ? a.start - b.start
      : b.end - b.start - (a.end - a.start),
  );

  // Step 4: greedily select non-overlapping
  const selected: typeof filtered = [];
  let lastEnd = 0;
  for (const m of filtered) {
    if (m.start >= lastEnd) {
      selected.push(m);
      lastEnd = m.end;
    }
  }
  return selected;
}

describe("property: oracle vs findIter", () => {
  test("findIter + wholeWords matches oracle", () => {
    fc.assert(
      fc.property(patterns, haystack, (pats, hay) => {
        const ac = new AhoCorasick(pats, {
          wholeWords: true,
        });
        const real = ac.findIter(hay);
        const oracle = oracleWholeWords(ac, hay);

        // Same number of matches
        expect(real.length).toBe(oracle.length);

        // Same positions and text
        for (let i = 0; i < real.length; i++) {
          expect(real[i]!.start).toBe(oracle[i]!.start);
          expect(real[i]!.end).toBe(oracle[i]!.end);
          expect(real[i]!.text).toBe(oracle[i]!.text);
        }
      }),
      PARAMS,
    );
  });

  test("isMatch + wholeWords agrees with findIter", () => {
    fc.assert(
      fc.property(patterns, haystack, (pats, hay) => {
        const ac = new AhoCorasick(pats, {
          wholeWords: true,
        });
        expect(ac.isMatch(hay)).toBe(
          ac.findIter(hay).length > 0,
        );
      }),
      PARAMS,
    );
  });

  test("replaceAll + wholeWords consistent with findIter", () => {
    fc.assert(
      fc.property(patterns, haystack, (pats, hay) => {
        const ac = new AhoCorasick(pats, {
          wholeWords: true,
        });
        const matches = ac.findIter(hay);
        const repls = pats.map((_, i) => `[${i}]`);
        const result = ac.replaceAll(hay, repls);

        // Manually build expected from findIter
        let expected = "";
        let last = 0;
        for (const m of matches) {
          expected += hay.slice(last, m.start);
          expected += repls[m.pattern]!;
          last = m.end;
        }
        expected += hay.slice(last);

        expect(result).toBe(expected);
      }),
      PARAMS,
    );
  });
});

// ─── Property 7: wholeWords isolated pattern ──
//
// This is the property that would have caught the
// "P shadows Pavel" bug WITHOUT knowing about it.

describe("property: wholeWords finds isolated patterns", () => {
  test("pattern surrounded by spaces is always found", () => {
    fc.assert(
      fc.property(
        // Generate 2-50 patterns, some may share
        // prefixes or contain spaces (which stress
        // the overlapping search path)
        fc.array(
          fc.string({
            minLength: 1,
            maxLength: 10,
          }),
          { minLength: 2, maxLength: 50 },
        ),
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

          // The target must be found at exactly
          // position 4 (after "xxx "), or a longer
          // pattern that covers position 4 must be
          // present.
          const targetFound = matches.some(
            (m) =>
              m.start === 4 && m.end >= 4 + target.length,
          );
          expect(targetFound).toBe(true);
        },
      ),
      PARAMS,
    );
  });
});

// ─── Property 8: findIter oracle (no wholeWords)

describe("property: findIter oracle (no wholeWords)", () => {
  test("findIter matches overlapping → greedy select", () => {
    fc.assert(
      fc.property(patterns, haystack, (pats, hay) => {
        const ac = new AhoCorasick(pats);
        const real = ac.findIter(hay);
        const all = ac.findOverlappingIter(hay);

        // Oracle: sort by start, then by pattern
        // index (leftmostFirst = first-added wins).
        all.sort((a, b) =>
          a.start !== b.start
            ? a.start - b.start
            : a.pattern - b.pattern,
        );
        const oracle: typeof all = [];
        let lastEnd = 0;
        for (const m of all) {
          if (m.start >= lastEnd) {
            oracle.push(m);
            lastEnd = m.end;
          }
        }

        expect(real.length).toBe(oracle.length);
        for (let i = 0; i < real.length; i++) {
          expect(real[i]!.start).toBe(oracle[i]!.start);
          expect(real[i]!.text).toBe(oracle[i]!.text);
        }
      }),
      PARAMS,
    );
  });
});

// ─── Property 9: replaceAll oracle (no wholeWords)

describe("property: replaceAll oracle (no wholeWords)", () => {
  test("replaceAll matches findIter-based reconstruction", () => {
    fc.assert(
      fc.property(patterns, haystack, (pats, hay) => {
        const ac = new AhoCorasick(pats);
        const repls = pats.map((_, i) => `[${i}]`);
        const result = ac.replaceAll(hay, repls);

        // Oracle: build from findIter positions.
        const matches = ac.findIter(hay);
        let expected = "";
        let last = 0;
        for (const m of matches) {
          expected += hay.slice(last, m.start);
          expected += repls[m.pattern]!;
          last = m.end;
        }
        expected += hay.slice(last);

        expect(result).toBe(expected);
      }),
      PARAMS,
    );
  });
});

// ─── Property 10: StreamMatcher oracle ────────

describe("property: StreamMatcher oracle", () => {
  test("chunked search finds same matches as findIter on full string", () => {
    fc.assert(
      fc.property(
        patterns,
        // Generate ASCII haystack so byte offsets
        // match UTF-16 offsets for comparison.
        fc.string({
          minLength: 0,
          maxLength: 500,
          unit: fc.constantFrom(
            ..."abcdefghijklmnopqrstuvwxyz .,-".split(""),
          ),
        }),
        // Chunk size 1-50
        fc.integer({ min: 1, max: 50 }),
        (pats, hay, chunkSize) => {
          const { StreamMatcher } = require("../lib");

          // Oracle: findIter on full string
          const ac = new AhoCorasick(pats);
          const oracleMatches = ac.findIter(hay);

          // Real: StreamMatcher in chunks
          const sm = new StreamMatcher(pats);
          const buf = Buffer.from(hay);
          const streamMatches: {
            pattern: number;
            text: string;
          }[] = [];

          for (let i = 0; i < buf.length; i += chunkSize) {
            const chunk = buf.subarray(i, i + chunkSize);
            for (const m of sm.write(chunk)) {
              streamMatches.push({
                pattern: m.pattern,
                text: hay.slice(m.start, m.end),
              });
            }
          }
          sm.flush();

          // Same match count
          expect(streamMatches.length).toBe(
            oracleMatches.length,
          );

          // Same matched text (offsets differ:
          // stream uses byte offsets, findIter
          // uses UTF-16, but for ASCII they're
          // identical).
          for (let i = 0; i < streamMatches.length; i++) {
            expect(streamMatches[i]!.text).toBe(
              oracleMatches[i]!.text,
            );
          }
        },
      ),
      PARAMS,
    );
  });
});
