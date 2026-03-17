// @ts-nocheck
/* Wrapper that unpacks Uint32Array results from
 * the native module into Match objects. */

const native = require("./index.js");

const NativeAhoCorasick = native.AhoCorasick;
const NativeStreamMatcher = native.StreamMatcher;

/**
 * Unpack a Uint32Array of [pattern, start, end, ...]
 * triples into Match objects.
 */
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
    this._inner = new NativeAhoCorasick(
      patterns,
      options,
    );
    this._wholeWords = options?.wholeWords ?? false;
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
      this._inner._findOverlappingIterPacked(
        haystack,
      ),
      haystack,
    );
  }

  replaceAll(haystack, replacements) {
    if (this._wholeWords) {
      // Use findIter (respects wholeWords) and
      // build the replacement string manually.
      const matches = this.findIter(haystack);
      let result = "";
      let last = 0;
      for (const m of matches) {
        result += haystack.slice(last, m.start);
        result += replacements[m.pattern];
        last = m.end;
      }
      result += haystack.slice(last);
      return result;
    }
    return this._inner.replaceAll(
      haystack,
      replacements,
    );
  }

}

module.exports.AhoCorasick = AhoCorasick;
module.exports.StreamMatcher = NativeStreamMatcher;
