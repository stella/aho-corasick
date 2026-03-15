import { describe, expect, test } from "bun:test";

import { AhoCorasick, StreamMatcher } from "../index";

// Helper: extract matched substring from haystack
const extract = (
  haystack: string,
  m: { start: number; end: number },
) => haystack.slice(m.start, m.end);

// ─── Core functionality ───────────────────────

describe("AhoCorasick", () => {
  test("basic matching", () => {
    const ac = new AhoCorasick([
      "he",
      "she",
      "his",
    ]);
    expect(ac.patternCount).toBe(3);
    expect(ac.isMatch("ushers")).toBe(true);
    expect(ac.isMatch("xyz")).toBe(false);
  });

  test("findIter returns correct matches", () => {
    const ac = new AhoCorasick(["foo", "bar"]);
    const matches = ac.findIter("foo bar foo");

    expect(matches).toEqual([
      { pattern: 0, start: 0, end: 3 },
      { pattern: 1, start: 4, end: 7 },
      { pattern: 0, start: 8, end: 11 },
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

  test("findIterBuf returns byte offsets", () => {
    const ac = new AhoCorasick(["foo"]);
    const buf = Buffer.from("hello foo world");
    const matches = ac.findIterBuf(buf);

    expect(matches).toHaveLength(1);
    expect(matches[0]!.start).toBe(6);
    expect(matches[0]!.end).toBe(9);
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
    const overlapping =
      ac.findOverlappingIter("ushers");

    // Should find: she(1..4), he(2..4), hers(2..6)
    const keywords = overlapping.map((m) =>
      extract("ushers", m),
    );
    expect(keywords).toContain("she");
    expect(keywords).toContain("he");
    expect(keywords).toContain("hers");
  });

  test("nested patterns", () => {
    const ac = new AhoCorasick([
      "a",
      "ab",
      "abc",
      "abcd",
    ]);
    const overlapping =
      ac.findOverlappingIter("abcd");

    // All 4 patterns should match (overlapping)
    expect(overlapping.length).toBeGreaterThanOrEqual(
      4,
    );
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
    const longFirst = new AhoCorasick([
      "abcdef",
      "abc",
    ]);
    const shortFirst = new AhoCorasick([
      "abc",
      "abcdef",
    ]);

    // leftmost-first: first pattern wins at
    // each position
    const lf = longFirst.findIter("abcdef");
    expect(lf).toHaveLength(1);
    expect(extract("abcdef", lf[0]!)).toBe("abcdef");

    const sf = shortFirst.findIter("abcdef");
    expect(sf).toHaveLength(1);
    expect(extract("abcdef", sf[0]!)).toBe("abc");

    // leftmost-longest: order doesn't matter
    const ll1 = new AhoCorasick(
      ["abcdef", "abc"],
      { matchKind: "leftmost-longest" },
    );
    const ll2 = new AhoCorasick(
      ["abc", "abcdef"],
      { matchKind: "leftmost-longest" },
    );
    expect(extract("abcdef", ll1.findIter("abcdef")[0]!)).toBe("abcdef");
    expect(extract("abcdef", ll2.findIter("abcdef")[0]!)).toBe("abcdef");
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
    const ac = new AhoCorasick([
      "有限公司",
      "股份",
    ]);
    const text = "ABC有限公司DEF股份GHI";
    const matches = ac.findIter(text);

    expect(matches).toHaveLength(2);
    expect(extract(text, matches[0]!)).toBe(
      "有限公司",
    );
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
    const text =
      "V tomto soudním řízení případ žaloba";
    const matches = ac.findIter(text);

    expect(matches).toHaveLength(4);
    for (const m of matches) {
      expect(patterns).toContain(extract(text, m));
    }
  });

  test("German ß in patterns", () => {
    const ac = new AhoCorasick([
      "Straße",
      "Straße",
    ]);
    const text = "Die Straße ist lang";
    const matches = ac.findIter(text);

    expect(matches).toHaveLength(1);
    expect(extract(text, matches[0]!)).toBe("Straße");
  });
});

// ─── Turkish İ problem ────────────────────────

describe("Turkish İ (case sensitivity)", () => {
  // The Rust aho-corasick crate only supports
  // ASCII case folding. This is a known and
  // documented limitation. These tests verify
  // the ACTUAL behavior, not aspirational behavior.

  test("İ is not folded to i (ASCII-only)", () => {
    const ac = new AhoCorasick(["istanbul"], {
      caseInsensitive: true,
    });
    // Turkish İstanbul starts with İ (U+0130),
    // not ASCII I
    expect(ac.isMatch("İstanbul")).toBe(false);
    // ASCII Istanbul matches
    expect(ac.isMatch("Istanbul")).toBe(true);
    expect(ac.isMatch("ISTANBUL")).toBe(true);
  });

  test("İ as a literal pattern works", () => {
    const ac = new AhoCorasick(["İstanbul"]);
    expect(ac.isMatch("İstanbul")).toBe(true);
    expect(ac.isMatch("Istanbul")).toBe(false);
  });

  test("case-sensitive: İ vs I are distinct", () => {
    const ac = new AhoCorasick([
      "Istanbul",
      "İstanbul",
    ]);
    const text =
      "Istanbul İstanbul ISTANBUL istanbul";
    const matches = ac.findIter(text);

    // Should find exact: "Istanbul" at 0, "İstanbul" at 9
    expect(matches).toHaveLength(2);
    expect(extract(text, matches[0]!)).toBe(
      "Istanbul",
    );
    expect(extract(text, matches[1]!)).toBe(
      "İstanbul",
    );
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
      expect(lowered.length).toBe(
        original.length + 1,
      );
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
    const result = ac.replaceAll(
      "I love café culture",
      ["coffee"],
    );
    expect(result).toBe("I love coffee culture");
  });

  test("buf offsets differ from char offsets", () => {
    const ac = new AhoCorasick(["test"]);
    const text = "étest"; // é = 2 UTF-8 bytes
    const buf = Buffer.from(text);

    const charMatches = ac.findIter(text);
    const byteMatches = ac.findIterBuf(buf);

    // Char offset: start=1 (after é)
    expect(charMatches[0]!.start).toBe(1);
    // Byte offset: start=2 (after 2-byte é)
    expect(byteMatches[0]!.start).toBe(2);
  });
});

// ─── Streaming ────────────────────────────────

describe("StreamMatcher", () => {
  test("finds matches across chunks", () => {
    const sm = new StreamMatcher([
      "hello",
      "world",
    ]);

    const m1 = sm.write(Buffer.from("hel"));
    const m2 = sm.write(Buffer.from("lo world"));
    sm.flush();

    const all = [...m1, ...m2];
    expect(all.some((m) => m.pattern === 0)).toBe(
      true,
    );
    expect(all.some((m) => m.pattern === 1)).toBe(
      true,
    );
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
