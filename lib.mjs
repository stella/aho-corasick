// @ts-nocheck
/* ESM wrapper. Imports the CJS native module via
 * createRequire and re-exports with the same
 * unpack logic as lib.js. */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const native = require("./index.js");

const NativeAhoCorasick = native.AhoCorasick;
const NativeStreamMatcher = native.StreamMatcher;

function unpack(packed, haystack, names) {
  const len = packed.length;
  // eslint-disable-next-line unicorn/no-new-array
  const matches = new Array(len / 3);
  for (let i = 0, j = 0; i < len; i += 3, j++) {
    const idx = packed[i];
    const start = packed[i + 1];
    const end = packed[i + 2];
    const m = {
      pattern: idx,
      start,
      end,
      text: haystack.slice(start, end),
    };
    if (names && names[idx] !== undefined)
      m.name = names[idx];
    matches[j] = m;
  }
  return matches;
}

// ── Word boundary helpers ─────────────────────

function isWordCharUnicode(ch) {
  // Match Rust is_alphanumeric() || ch == '_'
  return /[\p{L}\p{N}_]/u.test(ch);
}

function isWordCharAscii(ch) {
  return /[a-zA-Z0-9_]/.test(ch);
}

function checkBoundary(haystack, pos, ascii) {
  const isWc = ascii ? isWordCharAscii : isWordCharUnicode;
  const before =
    pos > 0 && isWc(haystack[pos - 1]);
  const after =
    pos < haystack.length && isWc(haystack[pos]);
  return before !== after;
}

function filterWholeWords(matches, haystack, ascii) {
  return matches.filter(
    (m) =>
      checkBoundary(haystack, m.start, ascii) &&
      checkBoundary(haystack, m.end, ascii),
  );
}

// ── Pattern normalization ─────────────────────

function normalizePatterns(patterns) {
  const strings = [];
  const names = [];
  let hasNames = false;

  for (const p of patterns) {
    if (typeof p === "string") {
      strings.push(p);
      names.push(undefined);
    } else if (
      typeof p === "object" &&
      p !== null &&
      "pattern" in p
    ) {
      strings.push(p.pattern);
      if (p.name !== undefined) {
        hasNames = true;
        names.push(p.name);
      } else {
        names.push(undefined);
      }
    } else {
      throw new TypeError(
        "Pattern must be a string or " +
          "{ pattern: string; name?: string }",
      );
    }
  }

  return { strings, names: hasNames ? names : null };
}

class AhoCorasick {
  constructor(patterns, options) {
    const { strings, names } =
      normalizePatterns(patterns);
    this._names = names;

    // When unicodeBoundaries is false, handle
    // wholeWords in JS with ASCII boundary checks
    // instead of the native Unicode implementation.
    const unicodeWb =
      options?.unicodeBoundaries ?? true;
    this._jsWholeWords =
      !unicodeWb && (options?.wholeWords ?? false);

    const nativeOpts = options
      ? { ...options }
      : undefined;
    if (nativeOpts) {
      // JS-only option — don't leak to native
      delete nativeOpts.unicodeBoundaries;
      if (this._jsWholeWords) {
        nativeOpts.wholeWords = false;
      }
    }

    this._inner = new NativeAhoCorasick(
      strings,
      nativeOpts,
    );
  }

  get patternCount() {
    return this._inner.patternCount;
  }

  isMatch(haystack) {
    if (!this._jsWholeWords) {
      return this._inner.isMatch(haystack);
    }
    // Fallback: get matches and check boundaries
    return this.findIter(haystack).length > 0;
  }

  findIter(haystack) {
    let matches = unpack(
      this._inner._findIterPacked(haystack),
      haystack,
      this._names,
    );
    if (this._jsWholeWords) {
      matches = filterWholeWords(
        matches,
        haystack,
        true,
      );
    }
    return matches;
  }

  findOverlappingIter(haystack) {
    let matches = unpack(
      this._inner._findOverlappingIterPacked(haystack),
      haystack,
      this._names,
    );
    if (this._jsWholeWords) {
      matches = filterWholeWords(
        matches,
        haystack,
        true,
      );
    }
    return matches;
  }

  replaceAll(haystack, replacements) {
    if (replacements.length !== this.patternCount) {
      throw new Error(
        `Expected ${this.patternCount} ` +
          `replacements, got ${replacements.length}`,
      );
    }
    if (!this._jsWholeWords) {
      return this._inner.replaceAll(
        haystack,
        replacements,
      );
    }
    // JS-side replace for ASCII boundary mode
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

  findIterBuf(haystack) {
    return this._inner.findIterBuf(haystack);
  }

  isMatchBuf(haystack) {
    return this._inner.isMatchBuf(haystack);
  }
}

const StreamMatcher = NativeStreamMatcher;
export { AhoCorasick, StreamMatcher };
