// Runs the packed @stll/aho-corasick-wasm package in the browser and writes
// the outcome into #out for check.mjs.
import singleThreadWasmUrl from "@stll/aho-corasick-wasm/single-thread/wasm?url";

const out = document.getElementById("out");

const assertEqual = (label, actual, expected) => {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${label}: expected ${expectedJson}, got ${actualJson}`);
  }
};

const haystack = "Smlouva mezi GAISLEROVÁ a novák, podpis: Novák";
const patterns = ["Gaislerová", "Novák"];
const expected = [{ pattern: 1, text: "Novák" }];

const search = (label, AhoCorasick) => {
  const found = new AhoCorasick(patterns, { wholeWords: true }).findIter(
    haystack,
  );
  for (const match of found) {
    assertEqual(
      `${label} offsets`,
      haystack.slice(match.start, match.end),
      match.text,
    );
  }
  const matches = found.map(({ pattern, text }) => ({ pattern, text }));
  assertEqual(label, matches, expected);
  return matches;
};

try {
  // Default entry: threaded WASI build with its worker.
  const threaded = await import("@stll/aho-corasick-wasm");
  const matches = search("threaded findIter", threaded.AhoCorasick);
  const caseInsensitive = new threaded.AhoCorasick(["gaislerová"], {
    caseInsensitive: true,
  }).isMatch("Smlouva s Gaislerová");
  assertEqual("threaded caseInsensitive", caseInsensitive, true);

  // Single-thread entry, initialized from the bundled asset URL.
  const singleThread = await import("@stll/aho-corasick-wasm/single-thread");
  await singleThread.init(singleThreadWasmUrl);
  search("single-thread findIter", singleThread.AhoCorasick);

  // Single-thread entry with the embedded module.
  const inline = await import("@stll/aho-corasick-wasm/single-thread/inline");
  inline.initSync();
  search("inline findIter", inline.AhoCorasick);

  out.textContent = JSON.stringify({
    ok: true,
    crossOriginIsolated: globalThis.crossOriginIsolated,
    matches,
    entries: ["threaded", "single-thread", "single-thread/inline"],
  });
} catch (error) {
  out.textContent = JSON.stringify({
    ok: false,
    error: String(error?.stack ?? error),
  });
}
