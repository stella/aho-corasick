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

import { AhoCorasick } from "../src/lib";

// ─── Adapter type ─────────────────────────────

export type Lib = {
  name: string;
  build: (p: string[]) => unknown;
  search: (ac: unknown, h: string) => number;
};

// ─── All adapters ─────────────────────────────

export const libs: Lib[] = [
  {
    name: "@stll/aho-corasick",
    build: (p) => new AhoCorasick(p),
    search: (ac, h) =>
      (ac as AhoCorasick).findIter(h).length,
  },
  {
    name: "modern-ahocorasick",
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
    name: "ahocorasick",
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
    name: "@monyone/aho-corasick",
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
    name: "@tanishiking/aho-corasick",
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

// ─── Bench runner ─────────────────────────────

export const bench = (
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

export const printSpeedups = (
  times: number[],
) => {
  const stellaMs = times[0]!;
  console.log();
  for (let i = 1; i < libs.length; i++) {
    console.log(
      `  vs ${libs[i]!.name}: ` +
        `${(times[i]! / stellaMs).toFixed(1)}x`,
    );
  }
};

// ─── Shared pattern sets ──────────────────────

export const LEGAL = [
  "shall", "whereas", "herein", "thereof",
  "pursuant", "notwithstanding", "jurisdiction",
  "plaintiff", "defendant", "arbitration",
  "indemnify", "liability", "breach", "covenant",
  "warranty", "termination", "consideration",
  "executed", "binding", "amendment",
];

export const DNA = [
  "ATG", "TAA", "TAG", "TGA", "TATA", "CAAT",
  "GATA", "AATAAA", "GCGC", "TTTT", "AAAA",
  "CCCC", "ATCG", "CGTA", "GATC", "CTAG",
];

export const LARGE_PATTERN_SET = [
  "the", "and", "of", "to", "that", "in", "he",
  "shall", "unto", "for", "his", "it", "with",
  "not", "all", "they", "was", "is", "him",
  "them", "from", "but", "be", "which", "her",
  "thou", "their", "upon", "said", "ye", "have",
  "will", "my", "me", "are", "thee", "one",
  "king", "out", "children", "man", "lord",
  "people", "land", "Israel", "God", "house",
  "son", "saying", "came", "up", "when", "before",
  "had", "then", "also", "come", "over", "this",
  "went", "day", "two", "there", "even", "after",
  "were", "hand", "every", "may", "did", "into",
  "father", "made", "against", "great", "if",
  "earth", "city", "name", "let", "no", "an",
  "by", "do", "as", "so", "at", "or", "on",
  "now", "men", "down", "way", "should", "take",
  "put", "your", "has", "set", "own", "things",
  "given", "time", "three", "through", "head",
  "would", "more", "make", "servants", "called",
  "than", "water", "away", "heart", "other",
  "side", "could", "send", "tell", "know", "much",
  "right", "first", "because", "like", "years",
  "place", "good", "together", "words", "bring",
  "many", "between", "pass", "long", "might",
  "again", "altar", "eyes", "face", "mouth",
  "part", "brother", "blood", "gate", "war",
  "gold", "silver", "fire", "offering", "both",
  "without", "tribes", "priest", "number",
  "round", "tabernacle", "wilderness",
  "congregation", "holy", "among", "according",
  "burnt", "each", "about", "sword", "left",
  "dead", "field", "young", "morning", "life",
  "eat", "old", "rest", "night", "forty", "seven",
  "five", "hundred", "thousand", "twelve",
  "twenty", "thirty", "stood", "chief", "mighty",
  "armies", "peace", "evil", "wives", "covenant",
  "generations", "sons", "heard", "forth", "days",
  "death",
];

export { AhoCorasick };
export { MonYoneAC, TanishikingTrie };
export { BrunoAC, ModernAC };
