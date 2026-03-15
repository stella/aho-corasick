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
function unpack(packed) {
  const len = packed.length;
  const matches = new Array(len / 3);
  for (let i = 0, j = 0; i < len; i += 3, j++) {
    matches[j] = {
      pattern: packed[i],
      start: packed[i + 1],
      end: packed[i + 2],
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
  }

  get patternCount() {
    return this._inner.patternCount;
  }

  isMatch(haystack) {
    return this._inner.isMatch(haystack);
  }

  findIter(haystack) {
    return unpack(this._inner._findIterPacked(haystack));
  }

  findOverlappingIter(haystack) {
    return unpack(
      this._inner._findOverlappingIterPacked(haystack),
    );
  }

  replaceAll(haystack, replacements) {
    return this._inner.replaceAll(
      haystack,
      replacements,
    );
  }

  findIterBuf(haystack) {
    return this._inner.findIterBuf(haystack);
  }

  isMatchBuf(haystack) {
    return this._inner.isMatchBuf(haystack);
  }

  findInChunk(chunk) {
    return this._inner.findInChunk(chunk);
  }
}

module.exports.AhoCorasick = AhoCorasick;
module.exports.StreamMatcher = NativeStreamMatcher;
