import { describe, expect, test } from "bun:test";

import { AhoCorasick, StreamMatcher } from "../lib";

// Helper: extract matched substring from haystack
const extract = (
  haystack: string,
  m: { start: number; end: number },
) => haystack.slice(m.start, m.end);

// ─── Core functionality ───────────────────────

describe("AhoCorasick", () => {
  test("basic matching", () => {
    const ac = new AhoCorasick(["he", "she", "his"]);
    expect(ac.patternCount).toBe(3);
    expect(ac.isMatch("ushers")).toBe(true);
    expect(ac.isMatch("xyz")).toBe(false);
  });

  test("findIter returns correct matches", () => {
    const ac = new AhoCorasick(["foo", "bar"]);
    const matches = ac.findIter("foo bar foo");

    expect(matches).toEqual([
      { pattern: 0, start: 0, end: 3, text: "foo" },
      { pattern: 1, start: 4, end: 7, text: "bar" },
      { pattern: 0, start: 8, end: 11, text: "foo" },
    ]);
  });

  test("leftmost-longest semantics", () => {
    const ac = new AhoCorasick(["abc", "abcd"], {
      matchKind: "leftmost-longest",
    });
    const matches = ac.findIter("abcd");

    expect(matches).toHaveLength(1);
    expect(matches[0]!.pattern).toBe(1);
    expect(matches[0]!.end).toBe(4);
  });

  test("leftmost-first semantics", () => {
    const ac = new AhoCorasick(["abc", "abcd"], {
      matchKind: "leftmost-first",
    });
    const matches = ac.findIter("abcd");

    expect(matches).toHaveLength(1);
    expect(matches[0]!.pattern).toBe(0);
    expect(matches[0]!.end).toBe(3);
  });

  test("case-insensitive matching (ASCII)", () => {
    const ac = new AhoCorasick(["hello"], {
      caseInsensitive: true,
    });

    expect(ac.isMatch("HELLO WORLD")).toBe(true);

    const matches = ac.findIter("Hello hElLo");
    expect(matches).toHaveLength(2);
  });

  test("replaceAll", () => {
    const ac = new AhoCorasick(["foo", "bar"]);
    const result = ac.replaceAll("foo bar baz", [
      "FOO",
      "BAR",
    ]);
    expect(result).toBe("FOO BAR baz");
  });

  test("replaceAll throws on wrong count", () => {
    const ac = new AhoCorasick(["a", "b"]);
    expect(() => ac.replaceAll("ab", ["x"])).toThrow();
  });

  test("empty patterns array", () => {
    const ac = new AhoCorasick([]);
    expect(ac.patternCount).toBe(0);
    expect(ac.isMatch("anything")).toBe(false);
    expect(ac.findIter("anything")).toEqual([]);
  });

  test("empty haystack", () => {
    const ac = new AhoCorasick(["test"]);
    expect(ac.isMatch("")).toBe(false);
    expect(ac.findIter("")).toEqual([]);
  });

  test("both empty", () => {
    const ac = new AhoCorasick([]);
    expect(ac.findIter("")).toEqual([]);
  });

  test("dfa option", () => {
    const ac = new AhoCorasick(["test"], {
      dfa: true,
    });
    expect(ac.isMatch("a test")).toBe(true);
  });
});

// ─── Overlapping matches ──────────────────────

describe("overlapping matches", () => {
  test("classic textbook example", () => {
    const ac = new AhoCorasick([
      "he",
      "she",
      "his",
      "hers",
    ]);
    const overlapping = ac.findOverlappingIter("ushers");

    // Should find: she(1..4), he(2..4), hers(2..6)
    const keywords = overlapping.map((m) =>
      extract("ushers", m),
    );
    expect(keywords).toContain("she");
    expect(keywords).toContain("he");
    expect(keywords).toContain("hers");
  });

  test("nested patterns", () => {
    const ac = new AhoCorasick(["a", "ab", "abc", "abcd"]);
    const overlapping = ac.findOverlappingIter("abcd");

    // All 4 patterns should match (overlapping)
    expect(overlapping.length).toBeGreaterThanOrEqual(4);
  });

  test("non-overlapping skips nested", () => {
    const ac = new AhoCorasick(["a", "ab", "abc"]);
    const non = ac.findIter("abc");
    // Leftmost-first: "a" wins at position 0
    expect(non).toHaveLength(1);
    expect(non[0]!.pattern).toBe(0);
  });

  test("pattern insertion order matters (leftmost-first)", () => {
    // ahocorasick#3: users confused when long
    // matches before short ones changed results
    const longFirst = new AhoCorasick(["abcdef", "abc"]);
    const shortFirst = new AhoCorasick(["abc", "abcdef"]);

    // leftmost-first: first pattern wins at
    // each position
    const lf = longFirst.findIter("abcdef");
    expect(lf).toHaveLength(1);
    expect(extract("abcdef", lf[0]!)).toBe("abcdef");

    const sf = shortFirst.findIter("abcdef");
    expect(sf).toHaveLength(1);
    expect(extract("abcdef", sf[0]!)).toBe("abc");

    // leftmost-longest: order doesn't matter
    const ll1 = new AhoCorasick(["abcdef", "abc"], {
      matchKind: "leftmost-longest",
    });
    const ll2 = new AhoCorasick(["abc", "abcdef"], {
      matchKind: "leftmost-longest",
    });
    expect(
      extract("abcdef", ll1.findIter("abcdef")[0]!),
    ).toBe("abcdef");
    expect(
      extract("abcdef", ll2.findIter("abcdef")[0]!),
    ).toBe("abcdef");
  });

  test("pyahocorasick#133: longer pattern fails, shorter should still match", () => {
    // Regression from pyahocorasick: when a longer
    // candidate ("abd") fails partway through, the
    // shorter match ("b") at that position must
    // still be reported.
    const ac = new AhoCorasick(["b", "c", "abd"], {
      matchKind: "leftmost-longest",
    });
    const matches = ac.findIter("abc");
    const found = matches.map((m) => extract("abc", m));

    expect(found).toContain("b");
    expect(found).toContain("c");
  });

  test("pyahocorasick#133: CJK longer pattern fails", () => {
    // Same bug but with CJK: "国家知识产权局" fails
    // (not in text) but "知识产权" should still match.
    const ac = new AhoCorasick(
      ["知识产权", "国家知识产权局"],
      { matchKind: "leftmost-longest" },
    );
    const text = "国家知识产权";
    const matches = ac.findIter(text);

    expect(matches).toHaveLength(1);
    expect(extract(text, matches[0]!)).toBe("知识产权");
  });

  test("leftmost-longest with shared prefix", () => {
    // "alpha beta" should win over "alpha" at the
    // same position (iter_long use case from
    // pyahocorasick#21)
    const ac = new AhoCorasick(
      ["alpha", "alpha beta", "beta gamma", "gamma"],
      { matchKind: "leftmost-longest" },
    );
    const text = "I went to alpha beta gamma";
    const matches = ac.findIter(text);
    const found = matches.map((m) => extract(text, m));

    // "alpha beta" should win over "alpha"
    expect(found).toContain("alpha beta");
    // "gamma" should be found after "alpha beta"
    expect(found).toContain("gamma");
    // "alpha" alone should NOT appear (shadowed
    // by "alpha beta")
    expect(found).not.toContain("alpha");
  });
});

// ─── Unicode: character offsets ───────────────

describe("unicode character offsets", () => {
  test("2-byte UTF-8 (Latin diacritics)", () => {
    // "café" = 4 chars, 5 bytes (é = 2 bytes)
    const ac = new AhoCorasick(["café", "naïve"]);
    const text = "a café and naïve";
    const matches = ac.findIter(text);

    expect(matches).toHaveLength(2);
    expect(extract(text, matches[0]!)).toBe("café");
    expect(extract(text, matches[1]!)).toBe("naïve");
  });

  test("3-byte UTF-8 (CJK)", () => {
    // Each CJK char = 3 bytes in UTF-8
    const ac = new AhoCorasick(["有限公司", "股份"]);
    const text = "ABC有限公司DEF股份GHI";
    const matches = ac.findIter(text);

    expect(matches).toHaveLength(2);
    expect(extract(text, matches[0]!)).toBe("有限公司");
    expect(extract(text, matches[1]!)).toBe("股份");
    // Verify char offsets, not byte offsets
    expect(matches[0]!.start).toBe(3); // after "ABC"
    expect(matches[0]!.end).toBe(7); // 4 CJK chars
  });

  test("4-byte UTF-8 (emoji)", () => {
    // 🔥 = 4 bytes, 2 UTF-16 code units, 1 char
    const ac = new AhoCorasick(["🔥", "fire"]);
    const text = "it's 🔥 fire 🔥🔥";
    const matches = ac.findIter(text);

    expect(matches).toHaveLength(4);
    for (const m of matches) {
      const s = extract(text, m);
      expect(["🔥", "fire"]).toContain(s);
    }
  });

  test("mixed multi-byte widths", () => {
    // Mix of 1, 2, 3, 4 byte chars
    const ac = new AhoCorasick(["target"]);
    const text = "é有🔥target";
    // UTF-16 lengths: é=1, 有=1, 🔥=2 (surrogate)
    // So "target" starts at UTF-16 index 4
    const matches = ac.findIter(text);

    expect(matches).toHaveLength(1);
    expect(matches[0]!.start).toBe(4);
    expect(matches[0]!.end).toBe(10);
    expect(extract(text, matches[0]!)).toBe("target");
  });

  test("Czech legal terms (diacritics)", () => {
    const patterns = [
      "případ",
      "soudní",
      "řízení",
      "žaloba",
    ];
    const ac = new AhoCorasick(patterns);
    const text = "V tomto soudním řízení případ žaloba";
    const matches = ac.findIter(text);

    expect(matches).toHaveLength(4);
    for (const m of matches) {
      expect(patterns).toContain(extract(text, m));
    }
  });

  test("German ß in patterns", () => {
    const ac = new AhoCorasick(["Straße", "Straße"]);
    const text = "Die Straße ist lang";
    const matches = ac.findIter(text);

    expect(matches).toHaveLength(1);
    expect(extract(text, matches[0]!)).toBe("Straße");
  });
});

// ─── Turkish İ problem ────────────────────────

describe("Turkish İ (case sensitivity)", () => {
  // Uses Unicode Simple Case Folding (İ→i),
  // NOT to_lowercase (İ→i̇). Length-preserving
  // in character count, but İ (2 bytes) → i
  // (1 byte) changes UTF-8 byte width. Offset
  // mapping via SearchCtx handles this.

  test("İ is folded to i (simple case fold)", () => {
    const ac = new AhoCorasick(["istanbul"], {
      caseInsensitive: true,
    });
    // Turkish İstanbul: İ (U+0130) folds to i
    expect(ac.isMatch("İstanbul")).toBe(true);
    // ASCII Istanbul also matches
    expect(ac.isMatch("Istanbul")).toBe(true);
    expect(ac.isMatch("ISTANBUL")).toBe(true);
  });

  test("İ as a literal pattern works", () => {
    const ac = new AhoCorasick(["İstanbul"]);
    expect(ac.isMatch("İstanbul")).toBe(true);
    expect(ac.isMatch("Istanbul")).toBe(false);
  });

  test("case-sensitive: İ vs I are distinct", () => {
    const ac = new AhoCorasick(["Istanbul", "İstanbul"]);
    const text = "Istanbul İstanbul ISTANBUL istanbul";
    const matches = ac.findIter(text);

    // Should find exact: "Istanbul" at 0, "İstanbul" at 9
    expect(matches).toHaveLength(2);
    expect(extract(text, matches[0]!)).toBe("Istanbul");
    expect(extract(text, matches[1]!)).toBe("İstanbul");
  });

  test("ı (dotless i) is not folded to I", () => {
    const ac = new AhoCorasick(["i"], {
      caseInsensitive: true,
    });
    // Turkish dotless ı (U+0131) should NOT match
    expect(ac.isMatch("ı")).toBe(false);
    // Regular i and I should match
    expect(ac.isMatch("i")).toBe(true);
    expect(ac.isMatch("I")).toBe(true);
  });

  test("İ toLowerCase may change string length", () => {
    // İ (U+0130) lowercases differently across
    // runtimes:
    //   ICU-based (Node): İ → "i\u0307" (2 code units)
    //   Bun/JSC:          İ → "i" (1 code unit)
    //
    // If length changes, offsets from searching the
    // lowered string don't map back to the original.
    // This is a real footgun when users do
    // `text.toLowerCase()` before feeding to AC.
    const original = "AİBCD";
    const lowered = original.toLowerCase();

    const lengthChanged =
      original.length !== lowered.length;

    // Regardless of runtime behavior, the safe
    // approach is: search the original text with
    // explicit patterns for each casing, rather
    // than pre-lowercasing.
    const ac = new AhoCorasick(["İ"]);
    const matches = ac.findIter(original);
    expect(matches).toHaveLength(1);
    expect(extract(original, matches[0]!)).toBe("İ");

    // Document runtime behavior for awareness
    if (lengthChanged) {
      // ICU: "İ".toLowerCase() === "i\u0307"
      expect(lowered.length).toBe(original.length + 1);
    } else {
      // Bun/JSC: "İ".toLowerCase() === "i"
      expect(lowered.length).toBe(original.length);
    }
  });
});

// ─── German ß / ss equivalence ────────────────

describe("German ß case folding", () => {
  // ß uppercases to SS in German, but the Rust
  // crate does ASCII-only folding. ß (U+00DF)
  // is NOT ASCII, so it's not folded.

  test("ß is not folded to ss", () => {
    const ac = new AhoCorasick(["strasse"], {
      caseInsensitive: true,
    });
    // "Straße" contains ß, not ss
    expect(ac.isMatch("Straße")).toBe(false);
    expect(ac.isMatch("Strasse")).toBe(true);
    expect(ac.isMatch("STRASSE")).toBe(true);
  });

  test("ß as literal pattern matches exactly", () => {
    const ac = new AhoCorasick(["Straße"]);
    expect(ac.isMatch("Straße")).toBe(true);
    expect(ac.isMatch("Strasse")).toBe(false);
  });
});

// ─── Offset correctness after multi-byte ──────

describe("offset correctness after multi-byte", () => {
  test("pattern after emoji has correct offset", () => {
    // 🎉 = 2 UTF-16 code units (surrogate pair)
    const ac = new AhoCorasick(["hello"]);
    const text = "🎉hello";
    const matches = ac.findIter(text);

    expect(matches).toHaveLength(1);
    // 🎉 takes 2 UTF-16 code units
    expect(matches[0]!.start).toBe(2);
    expect(matches[0]!.end).toBe(7);
    expect(extract(text, matches[0]!)).toBe("hello");
  });

  test("multiple patterns after CJK", () => {
    const ac = new AhoCorasick(["ab", "cd"]);
    const text = "有限ab公司cd";
    const matches = ac.findIter(text);

    expect(matches).toHaveLength(2);
    expect(extract(text, matches[0]!)).toBe("ab");
    // CJK chars are 1 UTF-16 code unit each
    expect(matches[0]!.start).toBe(2);
    expect(extract(text, matches[1]!)).toBe("cd");
    // 有限(2) + ab(2) + 公司(2) = 6
    expect(matches[1]!.start).toBe(6);
  });

  test("replaceAll with multi-byte haystack", () => {
    const ac = new AhoCorasick(["café"]);
    const result = ac.replaceAll("I love café culture", [
      "coffee",
    ]);
    expect(result).toBe("I love coffee culture");
  });

  test("pyahocorasick#53: supplementary plane offsets", () => {
    // pyahocorasick had wrong end positions for
    // supplementary plane chars on Windows (UCS-2).
    // Our UTF-16 offset table handles this.
    const ac = new AhoCorasick(["🙈"]);
    const text = "see no evil 🙈 monkey";
    const matches = ac.findIter(text);

    expect(matches).toHaveLength(1);
    expect(extract(text, matches[0]!)).toBe("🙈");
    // 🙈 is 2 UTF-16 code units (surrogate pair)
    const start = matches[0]!.start;
    const end = matches[0]!.end;
    expect(end - start).toBe(2);
  });

  test("supplementary plane chars between matches", () => {
    // Multiple matches with emoji between them
    const ac = new AhoCorasick(["test"]);
    const text = "test🙈🙉🙊test";
    const matches = ac.findIter(text);

    expect(matches).toHaveLength(2);
    expect(extract(text, matches[0]!)).toBe("test");
    expect(extract(text, matches[1]!)).toBe("test");
    // First: 0..4, then 3 emoji * 2 units = 6,
    // so second: 10..14
    expect(matches[1]!.start).toBe(10);
  });
});

// ─── Whole word matching ──────────────────────

describe("wholeWords option", () => {
  test("basic whole word filtering", () => {
    const ac = new AhoCorasick(["test"], {
      wholeWords: true,
    });
    const matches = ac.findIter(
      "test testing tested a test",
    );

    // Only "test" at positions 0 and 23 are whole
    // words. "testing" and "tested" are partial.
    expect(matches).toHaveLength(2);
    expect(matches[0]!.text).toBe("test");
    expect(matches[0]!.start).toBe(0);
    expect(matches[1]!.text).toBe("test");
    expect(matches[1]!.start).toBe(22);
  });

  test("whole words with punctuation", () => {
    const ac = new AhoCorasick(["LLC"], {
      wholeWords: true,
    });
    const matches = ac.findIter(
      "ABC LLC, DEF (LLC) GHI-LLC",
    );

    // LLC surrounded by spaces/punctuation = whole
    expect(matches).toHaveLength(3);
  });

  test("whole words rejects partial", () => {
    const ac = new AhoCorasick(["art"], {
      wholeWords: true,
    });

    // "art" inside "start", "party", "article"
    expect(ac.findIter("start party article").length).toBe(
      0,
    );

    // "art" as whole word
    expect(ac.findIter("the art of code").length).toBe(1);
  });

  test("whole words with diacritics", () => {
    const ac = new AhoCorasick(["případ"], {
      wholeWords: true,
    });

    // "případ" inside "případu" (Czech genitive)
    expect(ac.findIter("v případu").length).toBe(0);

    // "případ" as whole word
    const matches = ac.findIter("tento případ je");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.text).toBe("případ");
  });

  test("whole words: CJK bypasses boundary check", () => {
    // CJK has no word boundaries; every character
    // boundary is valid.
    const ac = new AhoCorasick(["知识"], {
      wholeWords: true,
    });
    const matches = ac.findIter("国家知识产权");

    // Should match even though surrounded by other
    // CJK characters
    expect(matches).toHaveLength(1);
    expect(matches[0]!.text).toBe("知识");
  });

  test("whole words: mixed CJK and Latin", () => {
    const ac = new AhoCorasick(["LLC", "有限公司"], {
      wholeWords: true,
    });
    const text = "ABC有限公司 DEF LLC";
    const matches = ac.findIter(text);

    // Both should match: CJK always passes,
    // LLC is surrounded by space/end
    expect(matches).toHaveLength(2);
    expect(matches[0]!.text).toBe("有限公司");
    expect(matches[1]!.text).toBe("LLC");
  });

  test("whole words: start and end of string", () => {
    const ac = new AhoCorasick(["test"], {
      wholeWords: true,
    });

    // At start
    expect(ac.findIter("test is here").length).toBe(1);
    // At end
    expect(ac.findIter("this is test").length).toBe(1);
    // Entire string
    expect(ac.findIter("test").length).toBe(1);
  });

  test("whole words: numbers are word chars", () => {
    const ac = new AhoCorasick(["test"], {
      wholeWords: true,
    });

    // "test" adjacent to numbers = not whole word
    expect(ac.findIter("test123").length).toBe(0);
    expect(ac.findIter("123test").length).toBe(0);

    // "test" with space before number = whole word
    expect(ac.findIter("test 123").length).toBe(1);
  });

  test("whole words: Cyrillic boundary", () => {
    const ac = new AhoCorasick(["idea"], {
      wholeWords: true,
    });

    // "idea" inside Cyrillic context
    expect(ac.findIter("нетidea").length).toBe(0);

    // "idea" as whole word between Cyrillic
    expect(ac.findIter("нет idea тут").length).toBe(1);
  });

  test("whole words with overlapping patterns", () => {
    // leftmost-first: "he" wins over "hers" at
    // position 16 because "he" is inserted first.
    // Use leftmost-longest to get "hers".
    const ac = new AhoCorasick(["he", "she", "hers"], {
      wholeWords: true,
      matchKind: "leftmost-longest",
    });
    const text = "she said he has hers";
    const matches = ac.findIter(text);
    const found = matches.map((m) => m.text);

    expect(found).toContain("she");
    expect(found).toContain("he");
    expect(found).toContain("hers");
  });

  test("without wholeWords (default)", () => {
    const ac = new AhoCorasick(["test"]);

    // Without wholeWords, finds partial matches
    expect(ac.findIter("testing").length).toBe(1);
    expect(ac.findIter("testing")[0]!.text).toBe("test");
  });

  // tanishiking's "sugar" test
  test("whole words: sugar in sugarcane (tanishiking)", () => {
    const ac = new AhoCorasick(["sugar"], {
      wholeWords: true,
    });
    const text = "sugarcane sugarcane sugar canesugar";
    const matches = ac.findIter(text);

    expect(matches).toHaveLength(1);
    expect(matches[0]!.text).toBe("sugar");
    expect(matches[0]!.start).toBe(20);
  });
});

// ─── Bug regressions ──────────────────────────

describe("bug: wholeWords + leftmostFirst drops matches", () => {
  // When a shorter pattern (e.g., "P") has a lower
  // index than a longer pattern ("Pavel") and both
  // start at the same position, leftmostFirst picks
  // "P". If "P" fails the wholeWords check, the
  // iterator has already consumed that position and
  // "Pavel" is never seen.

  test("short prefix pattern shadows whole-word match", () => {
    // "P" is at index 0 (lower), "Pavel" at index 1
    // "P" matches at the start of "Pavel" but fails
    // wholeWords (followed by "a"). "Pavel" should
    // still be found.
    const ac = new AhoCorasick(["P", "Pavel"], {
      wholeWords: true,
    });
    const matches = ac.findIter("hello Pavel world");
    const found = matches.map((m) => m.text);

    expect(found).toContain("Pavel");
  });

  test("many prefix patterns with shared start", () => {
    // Simulates the real bug: 12 patterns starting
    // with "Pavel", plus single-letter patterns.
    const ac = new AhoCorasick(
      [
        "P",
        "Pa",
        "Pav",
        "Pavel",
        "Pavela",
        "Pavelchak",
        "Pavelec",
        "Pavelek",
        "Pavelka",
        "Pavelko",
        "Pavell",
        "Pavella",
        "pane",
      ],
      {
        wholeWords: true,
        caseInsensitive: true,
      },
    );
    const text = "Dobrý den, pane Pavel";
    const matches = ac.findIter(text);
    const found = matches.map((m) => m.text);

    expect(found).toContain("pane");
    expect(found).toContain("Pavel");
  });

  test("single-letter pattern blocks longer match", () => {
    const ac = new AhoCorasick(["a", "abc"], {
      wholeWords: true,
    });
    // "a" matches at start of "abc" but fails
    // wholeWords (followed by "b"). "abc" should
    // still match as a whole word.
    const matches = ac.findIter("x abc y");
    const found = matches.map((m) => m.text);

    expect(found).toContain("abc");
  });

  test("pattern with trailing space shadows shorter word (Devin's bug)", () => {
    // Devin review: if patterns include "a " (with
    // trailing space), leftmostLongest picks "a "
    // over "a", then "a " fails wholeWords because
    // the char after the space is alphanumeric.
    // The shorter "a" (which IS a whole word) is
    // consumed and lost.
    //
    // This ONLY fails with leftmostLongest post-
    // filter. The overlapping approach handles it.
    const ac = new AhoCorasick(["a", "a "], {
      wholeWords: true,
    });
    const matches = ac.findIter("xxx a yyy");
    const found = matches.map((m) => m.text);

    expect(found).toContain("a");
  });

  test("pattern with leading space shadows word", () => {
    const ac = new AhoCorasick(["test", " test"], {
      wholeWords: true,
    });
    const matches = ac.findIter("run test now");
    const found = matches.map((m) => m.text);

    expect(found).toContain("test");
  });

  test("hyphenated pattern shadows component word", () => {
    // "New-York" as a pattern could shadow "New"
    const ac = new AhoCorasick(["New", "New-York"], {
      wholeWords: true,
    });
    const matches = ac.findIter("visit New-Yorkers");
    const found = matches.map((m) => m.text);

    // "New" should match: it's followed by "-"
    // which is not alphanumeric = word boundary
    expect(found).toContain("New");
  });

  test("dotted pattern: s.r.o.", () => {
    // Legal forms with dots
    const ac = new AhoCorasick(["s", "s.r.o."], {
      wholeWords: true,
    });
    const matches = ac.findIter("firma s.r.o. Praha");
    const found = matches.map((m) => m.text);

    // "s.r.o." should match as whole word
    // (preceded by space, followed by space)
    expect(found).toContain("s.r.o.");
  });

  test("replaceAll respects wholeWords (Devin review)", () => {
    const ac = new AhoCorasick(["test"], {
      wholeWords: true,
    });

    // Only replace whole words, not partials
    expect(
      ac.replaceAll("test testing tested test", [
        "REPLACED",
      ]),
    ).toBe("REPLACED testing tested REPLACED");

    // Without wholeWords, replaces all
    const ac2 = new AhoCorasick(["test"]);
    expect(
      ac2.replaceAll("test testing tested test", ["X"]),
    ).toBe("X Xing Xed X");
  });

  test("replaceAll + İ + wholeWords: byte offset correctness", () => {
    // İ (U+0130) folds to i (U+0069): 2 bytes → 1 byte.
    // The replace_all wholeWords path must track
    // positions in both folded and original space.
    const ac = new AhoCorasick(["istanbul"], {
      caseInsensitive: true,
      wholeWords: true,
    });
    expect(
      ac.replaceAll("İstanbul is great", ["CITY"]),
    ).toBe("CITY is great");

    // Multiple İ occurrences
    expect(
      ac.replaceAll(
        "İstanbul and İstanbul",
        ["CITY"],
      ),
    ).toBe("CITY and CITY");
  });

  test("overlapping iterator ordering: end-ordered not start-ordered (Greptile P1)", () => {
    // Bug: find_whole_word_at breaks on m.start()
    // != start, but overlapping iterator returns
    // matches by END position. A match at start+1
    // that ends earlier comes BEFORE a match at
    // start that ends later, causing premature break.
    const ac = new AhoCorasick(["abc d", "abc", "b"], {
      wholeWords: true,
    });
    const matches = ac.findIter("abc df");
    const found = matches.map((m) => m.text);

    // "abc d" fails wholeWords (followed by "f")
    // Fallback should find "abc" (followed by " ")
    expect(found).toContain("abc");
  });

  test("isMatch respects wholeWords (Devin review)", () => {
    // Bug: isMatch bypassed wholeWords, returning
    // true when findIter returned zero matches.
    const ac = new AhoCorasick(["test"], {
      wholeWords: true,
    });

    // "test" inside "testing" is NOT a whole word
    expect(ac.isMatch("testing")).toBe(false);
    expect(ac.findIter("testing").length).toBe(0);

    // "test" as whole word
    expect(ac.isMatch("run test now")).toBe(true);
    expect(ac.findIter("run test now").length).toBe(1);

    // Consistency: isMatch and findIter must agree
    const texts = [
      "testing",
      "test",
      "a test b",
      "testbed",
      "attest",
      "the test.",
    ];
    for (const text of texts) {
      const matches = ac.findIter(text);
      expect(ac.isMatch(text)).toBe(matches.length > 0);
    }
  });

  test("pure word patterns: leftmostLongest would suffice", () => {
    // This case works with BOTH approaches.
    // Included to verify no regression.
    const ac = new AhoCorasick(
      [
        "P",
        "Pa",
        "Pavel",
        "Pavela",
        "Pavelka",
        "test",
        "testing",
      ],
      { wholeWords: true },
    );
    const text = "Pavel is testing a test";
    const matches = ac.findIter(text);
    const found = matches.map((m) => m.text);

    expect(found).toContain("Pavel");
    expect(found).toContain("test");
    // "testing" is followed by " " = whole word
    expect(found).toContain("testing");
    // "P" and "Pa" should NOT appear (inside "Pavel")
    expect(found).not.toContain("P");
    expect(found).not.toContain("Pa");
  });
});

// ─── Adopted from other libraries ─────────────
//
// Test cases sourced from:
// - github.com/BrunoRB/ahocorasick (test/basic.js)
// - github.com/sonofmagic/modern-ahocorasick
//   (test/index.test.ts, test/next.test.ts)
// - github.com/tanishiking/aho-corasick-js
//   (src/trie.test.ts)
// - github.com/G-Research/ahocorasick_rs
//   (tests/test_ac.py)
// - github.com/WojciechMula/pyahocorasick
//   (tests/test_issue_*.py, tests/test_unit.py)
// - github.com/BurntSushi/aho-corasick
//   (src/tests.rs)

describe("adopted: Cyrillic (BrunoRB)", () => {
  test("Cyrillic with suffix overlap", () => {
    const ac = new AhoCorasick([
      "Федеральной",
      "ной",
      "idea",
    ]);
    const text =
      "! Федеральной I have no idea what this means.";
    const matches = ac.findIter(text);
    const found = matches.map((m) => extract(text, m));

    expect(found).toContain("Федеральной");
    expect(found).toContain("idea");
  });
});

describe("adopted: special characters (BrunoRB)", () => {
  test("newlines and special chars", () => {
    const ac = new AhoCorasick(["**", "666", "\n"]);
    const text = "\n & 666 ==! \n";
    const matches = ac.findIter(text);
    const found = matches.map((m) => extract(text, m));

    expect(found).toContain("\n");
    expect(found).toContain("666");
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  test("null byte patterns (BurntSushi)", () => {
    const ac = new AhoCorasick([
      "\x00\x00\x01",
      "\x00\x00\x00",
    ]);
    const matches = ac.findIter("\x00\x00\x00");
    expect(matches).toHaveLength(1);
    expect(extract("\x00\x00\x00", matches[0]!)).toBe(
      "\x00\x00\x00",
    );
  });
});

describe("adopted: emoji sequences (modern-ahocorasick)", () => {
  test("CJK Extension B (surrogate pairs)", () => {
    // 𠮟 (U+20B9F) is outside BMP
    const ac = new AhoCorasick(["𠮟", "𠮟る"]);
    const text = "人を𠮟る";
    const matches = ac.findIter(text);

    expect(matches.length).toBeGreaterThanOrEqual(1);
    for (const m of matches) {
      const s = extract(text, m);
      expect(["𠮟", "𠮟る"]).toContain(s);
    }
  });

  test("ZWJ family emoji", () => {
    const pattern = "👨‍👩‍👧‍👦";
    const ac = new AhoCorasick([pattern]);
    const text = "😁👨‍👩‍👧‍👦😀";
    const matches = ac.findIter(text);

    expect(matches).toHaveLength(1);
    expect(extract(text, matches[0]!)).toBe(pattern);
  });

  test("table flip unicode (BrunoRB)", () => {
    const ac = new AhoCorasick(["°□°", "┻━┻"]);
    const text = "- (╯°□°)╯︵ ┻━┻ ";
    const matches = ac.findIter(text);
    const found = matches.map((m) => extract(text, m));

    expect(found).toContain("°□°");
    expect(found).toContain("┻━┻");
  });

  test("emoji with snowman (ahocorasick_rs)", () => {
    const ac = new AhoCorasick(["d ☃f", "há", "l🤦l"]);
    const text = "hello, world ☃fishá l🤦l";
    const matches = ac.findIter(text);
    const found = matches.map((m) => extract(text, m));

    expect(found).toContain("d ☃f");
    expect(found).toContain("há");
    expect(found).toContain("l🤦l");
  });
});

describe("adopted: CJK supplementary (tanishiking)", () => {
  test("𩸽 (CJK Extension B) offset", () => {
    const ac = new AhoCorasick(["LOVE"]);
    const text = "𩸽 LOVE";
    const matches = ac.findIter(text);

    expect(matches).toHaveLength(1);
    expect(extract(text, matches[0]!)).toBe("LOVE");
    // 𩸽 = 2 UTF-16 code units, space = 1
    expect(matches[0]!.start).toBe(3);
  });

  test("hehehehe overlapping repetition", () => {
    const ac = new AhoCorasick(["he", "hehehehe"]);
    const overlapping =
      ac.findOverlappingIter("hehehehehe");
    const found = overlapping.map((m) =>
      extract("hehehehehe", m),
    );

    // Should find many "he" and at least one "hehehehe"
    expect(
      found.filter((s) => s === "he").length,
    ).toBeGreaterThanOrEqual(4);
    expect(found).toContain("hehehehe");
  });
});

describe("adopted: Polish diacritics (pyahocorasick#8)", () => {
  test("Polish diacritics: non-overlapping", () => {
    const ac = new AhoCorasick([
      "wąż",
      "mąż",
      "żółć",
      "aż",
      "waży",
    ]);
    const text = "wyważyć";
    const matches = ac.findIter(text);
    const found = matches.map((m) => extract(text, m));

    // leftmost-first: "waży" wins, "aż" is inside
    expect(found).toContain("waży");
    expect(found).not.toContain("aż");
  });

  test("Polish diacritics: overlapping", () => {
    const ac = new AhoCorasick([
      "wąż",
      "mąż",
      "żółć",
      "aż",
      "waży",
    ]);
    const text = "wyważyć";
    const overlapping = ac.findOverlappingIter(text);
    const found = overlapping.map((m) => extract(text, m));

    // overlapping finds both
    expect(found).toContain("waży");
    expect(found).toContain("aż");
  });
});

describe("adopted: match semantics (ahocorasick_rs)", () => {
  test("discontent: leftmost-first vs leftmost-longest", () => {
    const patterns = [
      "content",
      "disco",
      "disc",
      "discontent",
      "winter",
    ];
    const text = "This is the winter of my discontent";

    // leftmost-first: "disco" wins (inserted before
    // "discontent")
    const lf = new AhoCorasick(patterns);
    const lfMatches = lf.findIter(text);
    const lfFound = lfMatches.map((m) => extract(text, m));
    expect(lfFound).toContain("winter");
    expect(lfFound).toContain("disco");
    expect(lfFound).not.toContain("discontent");

    // leftmost-longest: "discontent" wins
    const ll = new AhoCorasick(patterns, {
      matchKind: "leftmost-longest",
    });
    const llMatches = ll.findIter(text);
    const llFound = llMatches.map((m) => extract(text, m));
    expect(llFound).toContain("winter");
    expect(llFound).toContain("discontent");
    expect(llFound).not.toContain("disco");
    expect(llFound).not.toContain("disc");
  });

  test("overlapping finds all", () => {
    const ac = new AhoCorasick([
      "content",
      "disco",
      "disc",
      "discontent",
      "winter",
    ]);
    const text = "This is the winter of my discontent";
    const overlapping = ac.findOverlappingIter(text);
    const found = overlapping.map((m) => extract(text, m));

    expect(found).toContain("winter");
    expect(found).toContain("disc");
    expect(found).toContain("disco");
    expect(found).toContain("discontent");
    expect(found).toContain("content");
  });
});

describe("adopted: edge cases (BurntSushi)", () => {
  test("sequential non-overlapping", () => {
    const ac = new AhoCorasick(["inf", "ind"]);
    const matches = ac.findIter("infind");
    expect(matches).toHaveLength(2);
    expect(extract("infind", matches[0]!)).toBe("inf");
    expect(extract("infind", matches[1]!)).toBe("ind");
  });

  test("pattern order preserved in results", () => {
    const ac = new AhoCorasick(["ind", "inf"]);
    const matches = ac.findIter("infind");
    expect(matches).toHaveLength(2);
    // "inf" matches first (position 0), "ind" at 3
    expect(extract("infind", matches[0]!)).toBe("inf");
    expect(extract("infind", matches[1]!)).toBe("ind");
  });

  test("path-like patterns", () => {
    const ac = new AhoCorasick(["libcore/", "libstd/"]);
    const matches = ac.findIter("libcore/char/methods.rs");
    expect(matches).toHaveLength(1);
    expect(
      extract("libcore/char/methods.rs", matches[0]!),
    ).toBe("libcore/");
  });

  test("near-miss long pattern (BurntSushi)", () => {
    const ac = new AhoCorasick(
      ["abcdefghi", "hz", "abcdefgh"],
      { matchKind: "leftmost-longest" },
    );
    const matches = ac.findIter("abcdefghz");
    expect(matches).toHaveLength(1);
    expect(extract("abcdefghz", matches[0]!)).toBe(
      "abcdefgh",
    );
  });

  test("sam prefix ambiguity (BurntSushi)", () => {
    const ac = new AhoCorasick(["amwix", "samwise", "sam"]);
    const matches = ac.findIter("Zsamwix");
    // "sam" matches before "samwise" could complete
    expect(matches).toHaveLength(1);
    expect(extract("Zsamwix", matches[0]!)).toBe("sam");
  });

  test("duplicate patterns under case folding (BurntSushi)", () => {
    const ac = new AhoCorasick(["foo", "FOO"], {
      caseInsensitive: true,
    });
    // Both patterns match "fOo"; leftmost-first
    // picks the first one
    const matches = ac.findIter("fOo");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.pattern).toBe(0);
  });

  test("case-insensitive mixed (BurntSushi)", () => {
    const ac = new AhoCorasick(["fOoBaR"], {
      caseInsensitive: true,
    });
    const matches = ac.findIter("quux foobar baz");
    expect(matches).toHaveLength(1);
    expect(extract("quux foobar baz", matches[0]!)).toBe(
      "foobar",
    );
  });

  test("suffix .com pattern (BrunoRB)", () => {
    const ac = new AhoCorasick([".com.au", ".com"]);
    expect(ac.findIter("www.yahoo.com").length).toBe(1);
    expect(
      extract(
        "www.yahoo.com",
        ac.findIter("www.yahoo.com")[0]!,
      ),
    ).toBe(".com");
    expect(ac.findIter("www.example.org").length).toBe(0);
  });

  test("misleading prefix: h he her hers (tanishiking)", () => {
    const ac = new AhoCorasick(["hers"]);
    const matches = ac.findIter("h he her hers");
    expect(matches).toHaveLength(1);
    expect(extract("h he her hers", matches[0]!)).toBe(
      "hers",
    );
  });

  test("duplicate patterns (modern-ahocorasick)", () => {
    const ac = new AhoCorasick(["a", "a", "b"]);
    const matches = ac.findIter("ab");
    // Should find "a" (at least once) and "b"
    const found = matches.map((m) => extract("ab", m));
    expect(found).toContain("a");
    expect(found).toContain("b");
  });

  test("case sensitivity: a vs A (modern-ahocorasick)", () => {
    const ac = new AhoCorasick(["a", "A"]);
    const matches = ac.findIter("Aa");
    expect(matches).toHaveLength(2);
    expect(extract("Aa", matches[0]!)).toBe("A");
    expect(extract("Aa", matches[1]!)).toBe("a");
  });

  test("repeated single char (pyahocorasick#10)", () => {
    const ac = new AhoCorasick(["S"]);
    const matches = ac.findIter("SSS");
    expect(matches).toHaveLength(3);
  });

  test("pyahocorasick#56: overlapping prefix/suffix", () => {
    const ac = new AhoCorasick([
      "poke",
      "go",
      "pokegois",
      "egoist",
    ]);
    const text = "pokego pokego  pokegoist";
    const matches = ac.findIter(text);

    // Verify we find matches (exact count depends
    // on leftmost-first semantics)
    expect(matches.length).toBeGreaterThanOrEqual(3);
    for (const m of matches) {
      expect([
        "poke",
        "go",
        "pokegois",
        "egoist",
      ]).toContain(extract(text, m));
    }
  });

  test("drug names: long match suppresses substring (pyahocorasick#133)", () => {
    const ac = new AhoCorasick(
      ["trimethoprim", "sulfamethoxazole", "meth"],
      { matchKind: "leftmost-longest" },
    );
    const text = "sulfamethoxazole and trimethoprim";
    const matches = ac.findIter(text);
    const found = matches.map((m) => extract(text, m));

    expect(found).toContain("sulfamethoxazole");
    expect(found).toContain("trimethoprim");
    // "meth" is inside both, should be suppressed
    expect(found).not.toContain("meth");
  });
});

// ─── Buffer methods ──────────────────────────

describe("findIterBuf", () => {
  test("basic byte-offset matching", () => {
    const ac = new AhoCorasick(["foo", "bar"]);
    const buf = Buffer.from("foo bar foo");
    const matches = ac.findIterBuf(buf);

    expect(matches).toHaveLength(3);
    expect(matches[0]).toEqual({
      pattern: 0,
      start: 0,
      end: 3,
    });
    expect(matches[1]).toEqual({
      pattern: 1,
      start: 4,
      end: 7,
    });
    expect(matches[2]).toEqual({
      pattern: 0,
      start: 8,
      end: 11,
    });
  });

  test("returns byte offsets for multibyte UTF-8", () => {
    // "č" is 2 bytes in UTF-8 but 1 UTF-16 code unit
    const ac = new AhoCorasick(["test"]);
    const text = "č test";
    const buf = Buffer.from(text);
    const matches = ac.findIterBuf(buf);

    expect(matches).toHaveLength(1);
    // "č" = 2 bytes + " " = 1 byte → start at 3
    expect(matches[0]!.start).toBe(3);
    expect(matches[0]!.end).toBe(7);
  });

  test("no text field on ByteMatch", () => {
    const ac = new AhoCorasick(["abc"]);
    const matches = ac.findIterBuf(Buffer.from("abc"));
    expect(matches).toHaveLength(1);
    expect("text" in matches[0]!).toBe(false);
  });

  test("accepts Uint8Array", () => {
    const ac = new AhoCorasick(["hello"]);
    const buf = new Uint8Array(Buffer.from("hello world"));
    const matches = ac.findIterBuf(buf);
    expect(matches).toHaveLength(1);
  });
});

describe("isMatchBuf", () => {
  test("returns true when pattern found", () => {
    const ac = new AhoCorasick(["needle"]);
    expect(
      ac.isMatchBuf(Buffer.from("haystack needle hay")),
    ).toBe(true);
  });

  test("returns false when no match", () => {
    const ac = new AhoCorasick(["needle"]);
    expect(
      ac.isMatchBuf(Buffer.from("haystack only")),
    ).toBe(false);
  });

  test("empty patterns never match", () => {
    const ac = new AhoCorasick([]);
    expect(ac.isMatchBuf(Buffer.from("anything"))).toBe(
      false,
    );
  });
});

// ─── Streaming ────────────────────────────────

describe("StreamMatcher", () => {
  test("finds matches across chunks", () => {
    const sm = new StreamMatcher(["hello", "world"]);

    const m1 = sm.write(Buffer.from("hel"));
    const m2 = sm.write(Buffer.from("lo world"));
    const m3 = sm.flush();

    const all = [...m1, ...m2, ...m3];
    expect(all.some((m) => m.pattern === 0)).toBe(true);
    expect(all.some((m) => m.pattern === 1)).toBe(true);
  });

  test("reset clears state", () => {
    const sm = new StreamMatcher(["abc"]);
    sm.write(Buffer.from("abc"));
    sm.reset();

    const matches = sm.write(Buffer.from("abc"));
    expect(matches).toHaveLength(1);
    expect(matches[0]!.start).toBe(0);
  });

  test("single-byte patterns need no overlap", () => {
    const sm = new StreamMatcher(["a", "b"]);
    const m1 = sm.write(Buffer.from("xa"));
    const m2 = sm.write(Buffer.from("bx"));
    sm.flush();

    const all = [...m1, ...m2];
    expect(all).toHaveLength(2);
  });

  test("match at exact chunk boundary", () => {
    const sm = new StreamMatcher(["abcdef"]);
    // Split right in the middle of the pattern
    const m1 = sm.write(Buffer.from("xyzabc"));
    const m2 = sm.write(Buffer.from("defxyz"));
    sm.flush();

    const all = [...m1, ...m2];
    expect(all).toHaveLength(1);
    // Global byte offset should be 3 ("xyz" prefix)
    expect(all[0]!.start).toBe(3);
    expect(all[0]!.end).toBe(9);
  });

  test("many small chunks", () => {
    const sm = new StreamMatcher(["needle"]);
    const text = "haystackneedlehaystack";

    // Feed one byte at a time
    for (let i = 0; i < text.length; i++) {
      sm.write(Buffer.from(text[i]!));
    }
    sm.flush();

    // We can't easily collect from this approach,
    // but at least verify no crash. Real usage
    // would collect from each write().
  });
});
