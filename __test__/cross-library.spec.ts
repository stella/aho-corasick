/**
 * Cross-library edge case comparison.
 *
 * Tests how every JS/TS Aho-Corasick library
 * handles unicode, emoji, Turkish İ, German ß,
 * CJK, and other tricky inputs.
 *
 * This is NOT a pass/fail test suite — it's a
 * documentation of actual behavior differences.
 */
import { describe, expect, test } from "bun:test";

import {
  AhoCorasick as MonYoneAC,
} from "@monyone/aho-corasick";
import {
  Trie as TanishikingTrie,
} from "@tanishiking/aho-corasick";
// @ts-expect-error — no type declarations
import BrunoAC from "ahocorasick";
// @ts-expect-error — no type declarations
import ModernAC from "modern-ahocorasick";

import { AhoCorasick } from "../index";

// ─── Helpers ──────────────────────────────────

type LibResult = {
  name: string;
  matches: { text: string; start: number }[];
  error?: string;
};

const runAll = (
  patterns: string[],
  haystack: string,
): LibResult[] => {
  const results: LibResult[] = [];

  // @stella/aho-corasick
  try {
    const ac = new AhoCorasick(patterns);
    const ms = ac.findIter(haystack);
    results.push({
      name: "@stella/aho-corasick",
      matches: ms.map((m) => ({
        text: haystack.slice(m.start, m.end),
        start: m.start,
      })),
    });
  } catch (e) {
    results.push({
      name: "@stella/aho-corasick",
      matches: [],
      error: String(e),
    });
  }

  // modern-ahocorasick
  try {
    const ac = new ModernAC(patterns);
    const ms = ac.search(haystack) as [
      number,
      string[],
    ][];
    const flat: { text: string; start: number }[] =
      [];
    for (const [endIdx, keywords] of ms) {
      for (const kw of keywords) {
        flat.push({
          text: kw,
          start: endIdx - kw.length + 1,
        });
      }
    }
    results.push({
      name: "modern-ahocorasick",
      matches: flat,
    });
  } catch (e) {
    results.push({
      name: "modern-ahocorasick",
      matches: [],
      error: String(e),
    });
  }

  // ahocorasick (BrunoRB)
  try {
    const ac = new BrunoAC(patterns);
    const ms = ac.search(haystack) as [
      number,
      string[],
    ][];
    const flat: { text: string; start: number }[] =
      [];
    for (const [endIdx, keywords] of ms) {
      for (const kw of keywords) {
        flat.push({
          text: kw,
          start: endIdx - kw.length + 1,
        });
      }
    }
    results.push({
      name: "ahocorasick",
      matches: flat,
    });
  } catch (e) {
    results.push({
      name: "ahocorasick",
      matches: [],
      error: String(e),
    });
  }

  // @monyone/aho-corasick
  try {
    const ac = new MonYoneAC(patterns);
    const flat: { text: string; start: number }[] =
      [];
    for (const m of ac.matchInText(haystack)) {
      flat.push({
        text: (m as { keyword: string }).keyword,
        start: (m as { begin: number }).begin,
      });
    }
    results.push({
      name: "@monyone/aho-corasick",
      matches: flat,
    });
  } catch (e) {
    results.push({
      name: "@monyone/aho-corasick",
      matches: [],
      error: String(e),
    });
  }

  // @tanishiking/aho-corasick
  try {
    const trie = new TanishikingTrie(patterns, {
      allowOverlaps: false,
    });
    const emits = trie.parseText(haystack) as {
      start: number;
      end: number;
      keyword: string;
    }[];
    results.push({
      name: "@tanishiking/aho-corasick",
      matches: emits.map((e) => ({
        text: e.keyword,
        start: e.start,
      })),
    });
  } catch (e) {
    results.push({
      name: "@tanishiking/aho-corasick",
      matches: [],
      error: String(e),
    });
  }

  return results;
};

const printResults = (
  label: string,
  results: LibResult[],
) => {
  console.log(`\n  ${label}`);
  for (const r of results) {
    if (r.error) {
      console.log(`    ${r.name}: ERROR ${r.error}`);
    } else {
      const summary = r.matches
        .map(
          (m) => `"${m.text}"@${m.start}`,
        )
        .join(", ");
      console.log(
        `    ${r.name}: ` +
          `${r.matches.length} matches` +
          (summary ? ` [${summary}]` : ""),
      );
    }
  }
};

// ─── Edge case tests ──────────────────────────

describe("cross-library: emoji", () => {
  test("emoji in haystack", () => {
    const results = runAll(
      ["fire", "hot"],
      "🔥 fire is hot 🔥",
    );
    printResults(
      'Patterns: ["fire","hot"], ' +
        'Haystack: "🔥 fire is hot 🔥"',
      results,
    );

    // Verify our offsets produce correct slices
    const ours = results.find(
      (r) => r.name === "@stella/aho-corasick",
    )!;
    expect(ours.matches).toHaveLength(2);
    expect(ours.matches[0]!.text).toBe("fire");
    expect(ours.matches[1]!.text).toBe("hot");
  });

  test("emoji as pattern", () => {
    const results = runAll(
      ["🔥", "🎉"],
      "wow 🔥 party 🎉 done",
    );
    printResults(
      'Patterns: ["🔥","🎉"], ' +
        'Haystack: "wow 🔥 party 🎉 done"',
      results,
    );

    const ours = results.find(
      (r) => r.name === "@stella/aho-corasick",
    )!;
    expect(ours.matches).toHaveLength(2);
    expect(ours.matches[0]!.text).toBe("🔥");
    expect(ours.matches[1]!.text).toBe("🎉");
  });

  test("consecutive emoji", () => {
    const results = runAll(
      ["🔥🎉"],
      "test🔥🎉test",
    );
    printResults(
      'Patterns: ["🔥🎉"], ' +
        'Haystack: "test🔥🎉test"',
      results,
    );

    const ours = results.find(
      (r) => r.name === "@stella/aho-corasick",
    )!;
    expect(ours.matches).toHaveLength(1);
    expect(ours.matches[0]!.text).toBe("🔥🎉");
  });

  test("pattern after multiple emoji", () => {
    const results = runAll(
      ["end"],
      "🔥🎉🚀end",
    );
    printResults(
      'Patterns: ["end"], ' +
        'Haystack: "🔥🎉🚀end"',
      results,
    );

    const ours = results.find(
      (r) => r.name === "@stella/aho-corasick",
    )!;
    expect(ours.matches).toHaveLength(1);
    expect(ours.matches[0]!.text).toBe("end");
    // 3 emoji * 2 UTF-16 code units = start at 6
    expect(ours.matches[0]!.start).toBe(6);
  });
});

describe("cross-library: Turkish İ", () => {
  test("İstanbul vs Istanbul (case-sensitive)", () => {
    const results = runAll(
      ["Istanbul", "İstanbul"],
      "Istanbul İstanbul ISTANBUL",
    );
    printResults(
      "Turkish İ (case-sensitive)",
      results,
    );

    const ours = results.find(
      (r) => r.name === "@stella/aho-corasick",
    )!;
    expect(ours.matches).toHaveLength(2);
    expect(ours.matches[0]!.text).toBe("Istanbul");
    expect(ours.matches[1]!.text).toBe("İstanbul");
  });

  test("Turkish dotless ı as pattern", () => {
    const results = runAll(
      ["ılık", "ilık"],
      "ılık su ve ilık çay",
    );
    printResults(
      "Turkish dotless ı vs regular i",
      results,
    );

    const ours = results.find(
      (r) => r.name === "@stella/aho-corasick",
    )!;
    expect(ours.matches).toHaveLength(2);
  });

  test("İ offset correctness", () => {
    // İ (U+0130) is 2 UTF-8 bytes, 1 UTF-16 unit
    const results = runAll(
      ["test"],
      "İtest",
    );
    printResults(
      'Pattern after İ — offset correctness',
      results,
    );

    const ours = results.find(
      (r) => r.name === "@stella/aho-corasick",
    )!;
    expect(ours.matches).toHaveLength(1);
    expect(ours.matches[0]!.text).toBe("test");
    // İ = 1 UTF-16 code unit, so start = 1
    expect(ours.matches[0]!.start).toBe(1);
  });
});

describe("cross-library: German ß", () => {
  test("ß in haystack", () => {
    const results = runAll(
      ["Straße", "Strasse"],
      "Die Straße und die Strasse",
    );
    printResults("German ß vs ss", results);

    const ours = results.find(
      (r) => r.name === "@stella/aho-corasick",
    )!;
    expect(ours.matches).toHaveLength(2);
    expect(ours.matches[0]!.text).toBe("Straße");
    expect(ours.matches[1]!.text).toBe("Strasse");
  });

  test("ß offset correctness", () => {
    // ß (U+00DF) is 2 UTF-8 bytes, 1 UTF-16 unit
    const results = runAll(
      ["end"],
      "Straße end",
    );
    printResults("Offset after ß", results);

    const ours = results.find(
      (r) => r.name === "@stella/aho-corasick",
    )!;
    expect(ours.matches).toHaveLength(1);
    expect(ours.matches[0]!.text).toBe("end");
  });
});

describe("cross-library: CJK", () => {
  test("Chinese legal forms", () => {
    const results = runAll(
      ["有限公司", "股份有限公司", "LLC"],
      "ABC有限公司 DEF股份有限公司 GHI LLC",
    );
    printResults("CJK legal forms", results);

    const ours = results.find(
      (r) => r.name === "@stella/aho-corasick",
    )!;
    // Leftmost-first: 有限公司 wins over
    // 股份有限公司 at the overlapping position
    expect(ours.matches.length).toBeGreaterThanOrEqual(
      2,
    );
  });

  test("Japanese mixed script", () => {
    const results = runAll(
      ["東京", "tokyo", "裁判所"],
      "東京tokyoの裁判所",
    );
    printResults("Japanese mixed script", results);

    const ours = results.find(
      (r) => r.name === "@stella/aho-corasick",
    )!;
    expect(ours.matches).toHaveLength(3);
  });
});

describe("cross-library: Czech diacritics", () => {
  test("Czech legal terms", () => {
    const results = runAll(
      ["případ", "řízení", "soudní"],
      "soudní řízení v případu",
    );
    printResults("Czech diacritics", results);

    const ours = results.find(
      (r) => r.name === "@stella/aho-corasick",
    )!;
    expect(ours.matches).toHaveLength(3);
    expect(ours.matches[0]!.text).toBe("soudní");
    expect(ours.matches[1]!.text).toBe("řízení");
    expect(ours.matches[2]!.text).toBe("případ");
  });
});

describe("cross-library: tricky patterns", () => {
  test("empty string in patterns", () => {
    // Some libraries crash on empty patterns
    const results: LibResult[] = [];

    try {
      const ac = new AhoCorasick(["", "test"]);
      results.push({
        name: "@stella/aho-corasick",
        matches: ac
          .findIter("test")
          .map((m) => ({
            text: "test".slice(m.start, m.end),
            start: m.start,
          })),
      });
    } catch (e) {
      results.push({
        name: "@stella/aho-corasick",
        matches: [],
        error: String(e),
      });
    }

    try {
      const ac = new ModernAC(["", "test"]);
      ac.search("test");
      results.push({
        name: "modern-ahocorasick",
        matches: [{ text: "ok", start: 0 }],
      });
    } catch (e) {
      results.push({
        name: "modern-ahocorasick",
        matches: [],
        error: String(e),
      });
    }

    printResults("Empty string in patterns", results);
    // We just verify no crash
  });

  test("very long pattern", () => {
    const longPattern = "a".repeat(10000);
    const haystack = "b".repeat(9999) + longPattern;

    const results = runAll([longPattern], haystack);
    printResults(
      "10K-char pattern in 20K-char haystack",
      results,
    );

    const ours = results.find(
      (r) => r.name === "@stella/aho-corasick",
    )!;
    expect(ours.matches).toHaveLength(1);
  });

  test("overlapping pattern prefixes", () => {
    // Classic AC edge case: patterns that are
    // prefixes of each other
    const results = runAll(
      ["ab", "abc", "abcd", "abcde"],
      "abcde",
    );
    printResults(
      "Overlapping prefixes (leftmost-first)",
      results,
    );

    const ours = results.find(
      (r) => r.name === "@stella/aho-corasick",
    )!;
    // Leftmost-first: "ab" wins
    expect(ours.matches).toHaveLength(1);
    expect(ours.matches[0]!.text).toBe("ab");
  });

  test("substring patterns", () => {
    const results = runAll(
      ["needle"],
      "needleneedleneedle",
    );
    printResults("Repeated adjacent matches", results);

    const ours = results.find(
      (r) => r.name === "@stella/aho-corasick",
    )!;
    expect(ours.matches).toHaveLength(3);
  });

  test("regex metacharacters as literals", () => {
    // Aho-Corasick should treat these as literals
    const results = runAll(
      ["a.b", "a*b", "a+b", "a?b", "[ab]"],
      "a.b a*b a+b a?b [ab]",
    );
    printResults("Regex metacharacters", results);

    const ours = results.find(
      (r) => r.name === "@stella/aho-corasick",
    )!;
    expect(ours.matches).toHaveLength(5);
  });
});

describe("cross-library: null bytes", () => {
  test("null byte in haystack", () => {
    const results = runAll(
      ["test"],
      "before\x00test\x00after",
    );
    printResults(
      "Null byte in haystack",
      results,
    );

    const ours = results.find(
      (r) => r.name === "@stella/aho-corasick",
    )!;
    expect(ours.matches).toHaveLength(1);
    expect(ours.matches[0]!.text).toBe("test");
  });
});
