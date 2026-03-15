/**
 * Unicode edge case benchmark.
 *
 * Tests performance on non-ASCII text: Czech
 * diacritics, emoji, CJK, Turkish İ/ı.
 *
 * Run: bun run bench:unicode
 */
import {
  bench,
  libs,
  printSpeedups,
} from "./helpers";

const N = 5;

console.log("=".repeat(62));
console.log(" UNICODE EDGE CASE BENCHMARKS");
console.log("=".repeat(62));

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

const germanText =
  "Die Straße führt zur Großen Mauer. " +
  "Gemäß Beschluss des Gerichts über " +
  "das Verfahren bezüglich der Klage. ".repeat(
    1000,
  );

const scenarios = [
  {
    label: `Czech diacritics (${(czechText.length / 1e3).toFixed(0)}K chars, 10 patterns)`,
    patterns: [
      "případ", "soudní", "řízení", "žaloba",
      "nárok", "důkaz", "smlouva", "zákon",
      "účastník", "rozhodnutí",
    ],
    haystack: czechText,
  },
  {
    label: `Emoji-heavy (${(emojiText.length / 1e3).toFixed(0)}K chars, 6 patterns)`,
    patterns: [
      "🔥", "fire", "🎉", "hot", "🚀", "launch",
    ],
    haystack: emojiText,
  },
  {
    label: `CJK legal forms (${(cjkText.length / 1e3).toFixed(0)}K chars, 5 patterns)`,
    patterns: [
      "有限公司", "株式会社", "合同会社",
      "LLC", "股份",
    ],
    haystack: cjkText,
  },
  {
    label: `Turkish İ/ı (${(turkishText.length / 1e3).toFixed(0)}K chars, 3 patterns)`,
    patterns: ["İstanbul", "istanbul", "ılık"],
    haystack: turkishText,
  },
  {
    label: `German ß/ü (${(germanText.length / 1e3).toFixed(0)}K chars, 4 patterns)`,
    patterns: [
      "Straße", "Beschluss", "Verfahren",
      "bezüglich",
    ],
    haystack: germanText,
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
