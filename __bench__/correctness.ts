/**
 * Cross-library correctness comparison.
 *
 * Runs every library on the same inputs and prints
 * match counts + offsets side by side. Flags
 * disagreements.
 *
 * Run: bun run bench:correctness
 */
import {
  AhoCorasick,
  BrunoAC,
  ModernAC,
  MonYoneAC,
  TanishikingTrie,
} from "./helpers";

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

  // @stll/aho-corasick
  try {
    const ac = new AhoCorasick(patterns);
    const ms = ac.findIter(haystack);
    results.push({
      name: "@stll/aho-corasick",
      matches: ms.map((m) => ({
        text: haystack.slice(m.start, m.end),
        start: m.start,
      })),
    });
  } catch (e) {
    results.push({
      name: "@stll/aho-corasick",
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

  // Check for disagreements
  const counts = results
    .filter((r) => !r.error)
    .map((r) => r.matches.length);
  const allSame =
    counts.length > 0 &&
    counts.every((c) => c === counts[0]);

  for (const r of results) {
    if (r.error) {
      console.log(
        `    ${r.name}: ` +
          `\x1b[31mERROR\x1b[0m ${r.error}`,
      );
      continue;
    }
    const summary = r.matches
      .slice(0, 5)
      .map((m) => `"${m.text}"@${m.start}`)
      .join(", ");
    const more =
      r.matches.length > 5
        ? ` (+${r.matches.length - 5} more)`
        : "";
    const marker = !allSame
      ? r.matches.length === counts[0]
        ? ""
        : " \x1b[33m⚠ DIFFERS\x1b[0m"
      : "";
    console.log(
      `    ${r.name}: ` +
        `${r.matches.length} matches` +
        (summary ? ` [${summary}${more}]` : "") +
        marker,
    );
  }
};

// ─── Scenarios ────────────────────────────────

console.log("=".repeat(62));
console.log(" CORRECTNESS CROSS-CHECK");
console.log(
  " All libraries, same inputs, side by side",
);
console.log("=".repeat(62));

// Emoji offsets
printResults(
  'Emoji: ["fire","hot"] in "🔥 fire is hot 🔥"',
  runAll(["fire", "hot"], "🔥 fire is hot 🔥"),
);

printResults(
  'Emoji patterns: ["🔥","🎉"] in "wow 🔥 party 🎉 done"',
  runAll(["🔥", "🎉"], "wow 🔥 party 🎉 done"),
);

printResults(
  'Consecutive emoji: ["🔥🎉"] in "test🔥🎉test"',
  runAll(["🔥🎉"], "test🔥🎉test"),
);

printResults(
  'After multiple emoji: ["end"] in "🔥🎉🚀end"',
  runAll(["end"], "🔥🎉🚀end"),
);

// Turkish İ
printResults(
  'Turkish İ: ["Istanbul","İstanbul"] case-sensitive',
  runAll(
    ["Istanbul", "İstanbul"],
    "Istanbul İstanbul ISTANBUL",
  ),
);

printResults(
  'Turkish dotless ı: ["ılık","ilık"]',
  runAll(
    ["ılık", "ilık"],
    "ılık su ve ilık çay",
  ),
);

printResults(
  'Offset after İ: ["test"] in "İtest"',
  runAll(["test"], "İtest"),
);

// German ß
printResults(
  'German ß: ["Straße","Strasse"]',
  runAll(
    ["Straße", "Strasse"],
    "Die Straße und die Strasse",
  ),
);

printResults(
  'Offset after ß: ["end"] in "Straße end"',
  runAll(["end"], "Straße end"),
);

// CJK
printResults(
  'CJK overlapping: ["有限公司","股份有限公司","LLC"]',
  runAll(
    ["有限公司", "股份有限公司", "LLC"],
    "ABC有限公司 DEF股份有限公司 GHI LLC",
  ),
);

printResults(
  'Japanese mixed: ["東京","tokyo","裁判所"]',
  runAll(
    ["東京", "tokyo", "裁判所"],
    "東京tokyoの裁判所",
  ),
);

// Czech diacritics
printResults(
  'Czech: ["případ","řízení","soudní"]',
  runAll(
    ["případ", "řízení", "soudní"],
    "soudní řízení v případu",
  ),
);

// Edge cases
printResults(
  'Empty pattern: ["","test"]',
  runAll(["", "test"], "test"),
);

printResults(
  "10K-char pattern in 20K-char haystack",
  runAll(
    ["a".repeat(10000)],
    "b".repeat(9999) + "a".repeat(10000),
  ),
);

printResults(
  'Overlapping prefixes: ["ab","abc","abcd","abcde"]',
  runAll(
    ["ab", "abc", "abcd", "abcde"],
    "abcde",
  ),
);

printResults(
  'Regex metacharacters: ["a.b","a*b","[ab]"]',
  runAll(
    ["a.b", "a*b", "a+b", "a?b", "[ab]"],
    "a.b a*b a+b a?b [ab]",
  ),
);

printResults(
  'Null byte: ["test"] in "before\\x00test"',
  runAll(["test"], "before\x00test\x00after"),
);

printResults(
  'Repeated adjacent: ["needle"] in "needleneedleneedle"',
  runAll(["needle"], "needleneedleneedle"),
);

console.log("\n" + "=".repeat(62));
console.log(" Done.");
console.log("=".repeat(62));
