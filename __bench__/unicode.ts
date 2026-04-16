/**
 * Unicode benchmark: Leipzig Corpora Collection
 *
 * Real-world text from academic corpora:
 * - Czech news (2024, Leipzig Corpora Collection)
 * - Turkish news (2024, Leipzig Corpora Collection)
 * - Japanese newscrawl (2019, Leipzig Corpora Collection)
 * - Chinese Wikipedia (2021, Leipzig Corpora Collection)
 * - German news (2024, Leipzig Corpora Collection)
 *
 * Ref: D. Goldhahn, T. Eckart, U. Quasthoff.
 * "Building Large Monolingual Dictionaries at the
 * Leipzig Corpora Collection." LREC 2012.
 *
 * Run: bun run bench:unicode
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { bench, libs, printSpeedups } from "./helpers";

const CORPUS = join(__dirname, "corpus");
const load = (name: string): string => {
  try {
    return readFileSync(join(CORPUS, name), "utf-8");
  } catch {
    return "";
  }
};

const ces = load("ces_news_2024_300K.txt");
const tur = load("tur_news_2024_300K.txt");
const jpn = load("jpn_newscrawl_2019_300K.txt");
const cmn = load("cmn_wikipedia_2021_300K.txt");
const deu = load("deu_news_2024_300K.txt");

const missing = [
  !ces && "Czech",
  !tur && "Turkish",
  !jpn && "Japanese",
  !cmn && "Chinese",
  !deu && "German",
].filter(Boolean);

if (missing.length > 0) {
  console.error(
    `Missing corpora: ${missing.join(", ")}.\n` +
      "Download from Leipzig Corpora Collection:\n" +
      "  bun run bench:download",
  );
  process.exit(1);
}

const N = 3;

console.log("=".repeat(62));
console.log(" UNICODE BENCHMARKS");
console.log(" Leipzig Corpora Collection (academic)");
console.log("=".repeat(62));

const scenarios = [
  {
    label: `Czech news (${(ces.length / 1e6).toFixed(1)} MB), 10 legal terms`,
    patterns: [
      "soudní",
      "řízení",
      "žaloba",
      "případ",
      "nárok",
      "důkaz",
      "smlouva",
      "zákon",
      "rozhodnutí",
      "účastník",
    ],
    haystack: ces,
  },
  {
    label: `Turkish news (${(tur.length / 1e6).toFixed(1)} MB), 10 terms`,
    patterns: [
      "mahkeme",
      "dava",
      "karar",
      "İstanbul",
      "hükümet",
      "başkan",
      "milyon",
      "şirket",
      "ülke",
      "dünya",
    ],
    haystack: tur,
  },
  {
    label: `Japanese newscrawl (${(jpn.length / 1e6).toFixed(1)} MB), 10 terms`,
    patterns: [
      "東京",
      "日本",
      "裁判所",
      "政府",
      "会社",
      "事件",
      "調査",
      "報告",
      "問題",
      "経済",
    ],
    haystack: jpn,
  },
  {
    label: `Chinese Wikipedia (${(cmn.length / 1e6).toFixed(1)} MB), 10 terms`,
    patterns: [
      "中国",
      "公司",
      "政府",
      "世界",
      "城市",
      "大学",
      "历史",
      "人民",
      "国家",
      "社会",
    ],
    haystack: cmn,
  },
  {
    label: `German news (${(deu.length / 1e6).toFixed(1)} MB), 10 terms`,
    patterns: [
      "Gericht",
      "Verfahren",
      "Beschluss",
      "Straße",
      "München",
      "Gesellschaft",
      "Regierung",
      "Unternehmen",
      "Deutschland",
      "Millionen",
    ],
    haystack: deu,
  },
];

for (const s of scenarios) {
  console.log(`\n### ${s.label}\n`);
  const times: number[] = [];
  for (const lib of libs) {
    const ac = lib.build(s.patterns);
    times.push(
      bench(lib.name, () => lib.search(ac, s.haystack), N),
    );
  }
  printSpeedups(times);
}

console.log("\n" + "=".repeat(62));
console.log(" Done.");
console.log("=".repeat(62));
