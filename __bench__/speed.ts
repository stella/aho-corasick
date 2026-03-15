/**
 * Speed benchmark: Canterbury Large Corpus
 *
 * Academic benchmark for string matching algorithms.
 * Tests large ASCII inputs (bible.txt, E.coli) and
 * a high-pattern-count stress test.
 *
 * Run: bun run bench:speed
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  bench,
  DNA,
  LEGAL,
  libs,
  printSpeedups,
} from "./helpers";

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
const world = load("world192.txt");
const ecoli = load("E.coli");

if (!bible || !ecoli) {
  console.error(
    "Corpus not found. Download:\n" +
      "  curl -Lo __bench__/c.zip " +
      "https://corpus.canterbury.ac.nz/" +
      "resources/large.zip\n" +
      "  unzip -d __bench__/corpus " +
      "__bench__/c.zip",
  );
  process.exit(1);
}

const N = 5;

console.log("=".repeat(62));
console.log(" SPEED BENCHMARKS");
console.log(
  " Canterbury Large Corpus (academic)",
);
console.log("=".repeat(62));

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
  ...(world
    ? [
        {
          label: `world192.txt (${(world.length / 1e6).toFixed(1)} MB) × 20 legal terms`,
          patterns: LEGAL,
          haystack: world,
        },
      ]
    : []),
  {
    label: `bible.txt × 1 pattern (baseline)`,
    patterns: ["God"],
    haystack: bible,
  },
];

for (const s of scenarios) {
  console.log(`\n### ${s.label}\n`);
  const times: number[] = [];
  for (const lib of libs) {
    const ac = lib.build(s.patterns);
    times.push(
      bench(
        lib.name,
        () => lib.search(ac, s.haystack),
        N,
      ),
    );
  }
  printSpeedups(times);
}

console.log("\n" + "=".repeat(62));
console.log(" Done.");
console.log("=".repeat(62));
