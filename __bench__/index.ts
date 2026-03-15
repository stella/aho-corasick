/**
 * @stella/aho-corasick benchmark suite
 *
 * Speed: Canterbury Large Corpus (academic)
 * Edge cases: emoji, Turkish İ, CJK, diacritics
 *
 * Run: bun run bench
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

// @ts-expect-error — no type declarations
import BrunoAC from "ahocorasick";
import {
  AhoCorasick as MonYoneAC,
} from "@monyone/aho-corasick";
import {
  Trie as TanishikingTrie,
} from "@tanishiking/aho-corasick";
// @ts-expect-error — no type declarations
import ModernAC from "modern-ahocorasick";

import { AhoCorasick } from "../index";

// ─── Corpus ───────────────────────────────────

const CORPUS = join(__dirname, "corpus");

const load = (name: string): string => {
  try {
    return readFileSync(
      join(CORPUS, name),
      "utf-8",
    );
  } catch {
    return "";
  }
};

const bible = load("bible.txt");
const ecoli = load("E.coli");

if (!bible || !ecoli) {
  console.error(
    "Corpus not found. Run:\n" +
      "  curl -Lo __bench__/c.zip " +
      "https://corpus.canterbury.ac.nz/" +
      "resources/large.zip\n" +
      "  unzip -d __bench__/corpus " +
      "__bench__/c.zip",
  );
  process.exit(1);
}

// ─── Harness ──────────────────────────────────

const bench = (
  name: string,
  fn: () => number,
  n: number,
) => {
  for (let i = 0; i < 2; i++) fn();
  const t = performance.now();
  let c = 0;
  for (let i = 0; i < n; i++) c = fn();
  const ms = (performance.now() - t) / n;
  console.log(
    `  ${name.padEnd(36)}` +
      `${ms.toFixed(2).padStart(10)} ms ` +
      `${String(c).padStart(8)} matches`,
  );
  return ms;
};

// ─── Adapters ─────────────────────────────────

type Lib = {
  name: string;
  build: (p: string[]) => unknown;
  search: (ac: unknown, h: string) => number;
};

const libs: Lib[] = [
  {
    name: "@stella/aho-corasick (Rust)",
    build: (p) => new AhoCorasick(p),
    search: (ac, h) =>
      (ac as AhoCorasick).findIter(h).length,
  },
  {
    name: "modern-ahocorasick (1.1M/wk)",
    build: (p) => new ModernAC(p),
    search: (ac, h) => {
      const r = (
        ac as InstanceType<typeof ModernAC>
      ).search(h) as [number, string[]][];
      let c = 0;
      for (const [, kw] of r) c += kw.length;
      return c;
    },
  },
  {
    name: "ahocorasick (65K/wk)",
    build: (p) => new BrunoAC(p),
    search: (ac, h) => {
      const r = (
        ac as InstanceType<typeof BrunoAC>
      ).search(h) as [number, string[]][];
      let c = 0;
      for (const [, kw] of r) c += kw.length;
      return c;
    },
  },
  {
    name: "@monyone/aho-corasick (16K/wk)",
    build: (p) => new MonYoneAC(p),
    search: (ac, h) => {
      let c = 0;
      for (const _ of (
        ac as InstanceType<typeof MonYoneAC>
      ).matchInText(h))
        c++;
      return c;
    },
  },
  {
    name: "@tanishiking/aho-corasick (1K/wk)",
    build: (p) =>
      new TanishikingTrie(p, {
        allowOverlaps: false,
      }),
    search: (ac, h) =>
      (
        ac as InstanceType<typeof TanishikingTrie>
      ).parseText(h).length,
  },
];

// ─── Speed benchmarks ─────────────────────────

console.log("=".repeat(62));
console.log(" SPEED BENCHMARKS");
console.log(
  " Canterbury Large Corpus (academic)",
);
console.log("=".repeat(62));

const LEGAL = [
  "shall",
  "whereas",
  "herein",
  "thereof",
  "pursuant",
  "notwithstanding",
  "jurisdiction",
  "plaintiff",
  "defendant",
  "arbitration",
  "indemnify",
  "liability",
  "breach",
  "covenant",
  "warranty",
  "termination",
  "consideration",
  "executed",
  "binding",
  "amendment",
];

const DNA = [
  "ATG",
  "TAA",
  "TAG",
  "TGA",
  "TATA",
  "CAAT",
  "GATA",
  "AATAAA",
  "GCGC",
  "TTTT",
  "AAAA",
  "CCCC",
  "ATCG",
  "CGTA",
  "GATC",
  "CTAG",
];

const N = 5;

const scenarios = [
  {
    label: `bible.txt (${(bible.length / 1e6).toFixed(1)} MB) × 20 legal terms`,
    patterns: LEGAL,
    haystack: bible,
  },
  {
    label: `E.coli (${(ecoli.length / 1e6).toFixed(1)} MB) × 16 DNA codons`,
    patterns: DNA,
    haystack: ecoli,
  },
];

for (const s of scenarios) {
  console.log(`\n### ${s.label}\n`);
  const times: number[] = [];
  for (const lib of libs) {
    const ac = lib.build(s.patterns);
    const ms = bench(
      lib.name,
      () => lib.search(ac, s.haystack),
      N,
    );
    times.push(ms);
  }
  const stellaMs = times[0]!;
  console.log();
  for (let i = 1; i < libs.length; i++) {
    console.log(
      `  vs ${libs[i]!.name.split(" (")[0]}: ` +
        `${(times[i]! / stellaMs).toFixed(1)}x faster`,
    );
  }
}

// ─── Edge case benchmarks ─────────────────────

console.log("\n" + "=".repeat(62));
console.log(" EDGE CASE BENCHMARKS");
console.log(
  " Unicode, emoji, diacritics, CJK",
);
console.log("=".repeat(62));

// Build various edge case haystacks
const czechText =
  "V tomto soudním řízení byla podána žaloba " +
  "na základě smlouvy. Případ se týká nároku " +
  "na náhradu škody dle zákona. Účastník " +
  "řízení podal důkaz. Rozhodnutí soudu bylo " +
  "vydáno v souladu se zákonem. ".repeat(1000);

const emojiText =
  "🔥 This is fire 🎉 and hot 🚀 launch " +
  "day 💪 strong 🌟 star ✨ sparkle ".repeat(
    1000,
  );

const cjkText =
  "ABC有限公司 DEF股份有限公司 GHI LLC " +
  "JKL合同会社 MNO株式会社 PQR ".repeat(1000);

const turkishText =
  "İstanbul'da bir mahkeme kararı verildi. " +
  "Istanbul ilçesi ılık havada güzel. " +
  "Dava sürecinde istanbul hakkında ".repeat(
    1000,
  );

const edgeCases = [
  {
    label: `Czech diacritics (${(czechText.length / 1e3).toFixed(0)}K chars, 10 patterns)`,
    patterns: [
      "případ",
      "soudní",
      "řízení",
      "žaloba",
      "nárok",
      "důkaz",
      "smlouva",
      "zákon",
      "účastník",
      "rozhodnutí",
    ],
    haystack: czechText,
  },
  {
    label: `Emoji-heavy text (${(emojiText.length / 1e3).toFixed(0)}K chars, 6 patterns)`,
    patterns: [
      "🔥",
      "fire",
      "🎉",
      "hot",
      "🚀",
      "launch",
    ],
    haystack: emojiText,
  },
  {
    label: `CJK legal forms (${(cjkText.length / 1e3).toFixed(0)}K chars, 5 patterns)`,
    patterns: [
      "有限公司",
      "株式会社",
      "合同会社",
      "LLC",
      "股份",
    ],
    haystack: cjkText,
  },
  {
    label: `Turkish İ/ı text (${(turkishText.length / 1e3).toFixed(0)}K chars, 3 patterns)`,
    patterns: [
      "İstanbul",
      "istanbul",
      "ılık",
    ],
    haystack: turkishText,
  },
];

for (const s of edgeCases) {
  console.log(`\n### ${s.label}\n`);
  const times: number[] = [];
  for (const lib of libs) {
    const ac = lib.build(s.patterns);
    const ms = bench(
      lib.name,
      () => lib.search(ac, s.haystack),
      N,
    );
    times.push(ms);
  }
  const stellaMs = times[0]!;
  console.log();
  for (let i = 1; i < libs.length; i++) {
    console.log(
      `  vs ${libs[i]!.name.split(" (")[0]}: ` +
        `${(times[i]! / stellaMs).toFixed(1)}x faster`,
    );
  }
}

console.log("\n" + "=".repeat(62));
console.log(" Done.");
console.log("=".repeat(62));
