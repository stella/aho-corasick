// @ts-nocheck
/* WASM-only wrapper. Loads the WASI module instead
 * of the native .node binary. Same API as lib.mjs. */
import native from "./aho-corasick.wasi-browser.js";

function unpack(packed, haystack) {
  const len = packed.length;
  // eslint-disable-next-line unicorn/no-new-array
  const matches = new Array(len / 3);
  for (let i = 0, j = 0; i < len; i += 3, j++) {
    const start = packed[i + 1];
    const end = packed[i + 2];
    matches[j] = {
      pattern: packed[i],
      start,
      end,
      text: haystack.slice(start, end),
    };
  }
  return matches;
}

class AhoCorasick {
  constructor(patterns, options) {
    this._inner = new native.AhoCorasick(patterns, options);
  }

  get patternCount() {
    return this._inner.patternCount;
  }

  isMatch(haystack) {
    return this._inner.isMatch(haystack);
  }

  findIter(haystack) {
    return unpack(
      this._inner._findIterPacked(haystack),
      haystack,
    );
  }

  findOverlappingIter(haystack) {
    return unpack(
      this._inner._findOverlappingIterPacked(haystack),
      haystack,
    );
  }

  replaceAll(haystack, replacements) {
    return this._inner.replaceAll(haystack, replacements);
  }

  findIterBuf(haystack) {
    return this._inner.findIterBuf(haystack);
  }

  isMatchBuf(haystack) {
    return this._inner.isMatchBuf(haystack);
  }
}

export { AhoCorasick };
export const StreamMatcher = native.StreamMatcher;
