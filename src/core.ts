/* Shared core: types, helpers, and classes that
 * use a late-bound native backend (NAPI-RS or WASM).
 * Call initBinding() before constructing classes. */

// ── Native binding types ────────────────────────

export type NativeBinding = {
  AhoCorasick: new (
    patterns: string[],
    options?: Record<string, unknown>,
  ) => NativeAhoCorasickInstance;
  StreamMatcher: new (
    patterns: string[],
    options?: Record<string, unknown>,
  ) => NativeStreamMatcherInstance;
};

type NativeAhoCorasickInstance = {
  patternCount: number;
  isMatch(haystack: string): boolean;
  _findIterPacked(haystack: string): Uint32Array;
  _findOverlappingIterPacked(haystack: string): Uint32Array;
  replaceAll(
    haystack: string,
    replacements: string[],
  ): string;
  findIterBuf(haystack: Buffer | Uint8Array): ByteMatch[];
  isMatchBuf(haystack: Buffer | Uint8Array): boolean;
};

type NativeStreamMatcherInstance = {
  write(chunk: Buffer | Uint8Array): ByteMatch[];
  flush(): ByteMatch[];
  reset(): void;
};

// ── Late-bound native binding ───────────────────

let binding: NativeBinding;

/** Set the native backend. Must be called once
 *  before any class constructor. */
export const initBinding = (b: NativeBinding) => {
  binding = b;
};

// ── Public types ────────────────────────────────

/**
 * Which match semantics to use.
 *
 * - `"leftmost-first"`: report the first pattern
 *   that matches (insertion order) at each position.
 * - `"leftmost-longest"`: report the longest match
 *   at each position.
 */
export type MatchKind =
  | "leftmost-first"
  | "leftmost-longest";

/** Options for constructing an automaton. */
export type Options = {
  /**
   * Match semantics.
   * @default "leftmost-first"
   */
  matchKind?: MatchKind;
  /**
   * Case-insensitive matching (ASCII only).
   * @default false
   */
  caseInsensitive?: boolean;
  /**
   * Force DFA mode. Uses more memory but can be
   * faster for large pattern sets.
   * @default false
   */
  dfa?: boolean;
  /**
   * Only match whole words. Uses Unicode
   * `is_alphanumeric()` for boundary detection
   * by default (covers all scripts). Set
   * `unicodeBoundaries: false` for ASCII-only.
   * @default false
   */
  wholeWords?: boolean;
  /**
   * Use Unicode word boundaries for `wholeWords`.
   * When `true` (default), `is_alphanumeric()` is
   * used (covers all scripts). When `false`, only
   * `[a-zA-Z0-9_]` are word characters.
   * @default true
   */
  unicodeBoundaries?: boolean;
};

/** A named pattern entry. */
export type PatternEntry =
  | string
  | { pattern: string; name?: string };

/** A single match result (string methods). */
export type Match = {
  /** Index into the patterns array. */
  pattern: number;
  /** Start UTF-16 code unit offset (compatible
   *  with `String.prototype.slice()`). */
  start: number;
  /** End offset (exclusive). */
  end: number;
  /** The matched text
   *  (`haystack.slice(start, end)`). */
  text: string;
  /** Pattern name (if provided). */
  name?: string;
};

/**
 * A single match result (Buffer / streaming
 * methods). Offsets are **byte** positions, not
 * UTF-16 code units.
 */
export type ByteMatch = {
  /** Index into the patterns array. */
  pattern: number;
  /** Start byte offset. */
  start: number;
  /** End byte offset (exclusive). */
  end: number;
};

// ── Unpack helper ───────────────────────────────

function unpack(
  packed: Uint32Array,
  haystack: string,
  names: (string | undefined)[] | null,
): Match[] {
  const len = packed.length;
  // eslint-disable-next-line unicorn/no-new-array
  const matches = new Array<Match>(len / 3);
  for (let i = 0, j = 0; i < len; i += 3, j++) {
    const idx = packed[i];
    const start = packed[i + 1];
    const end = packed[i + 2];
    if (
      idx === undefined ||
      start === undefined ||
      end === undefined
    ) {
      throw new Error(
        `Malformed packed matches at offset ${String(i)}`,
      );
    }
    const m: Match = {
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

// ── Word boundary helpers ───────────────────────

function isWordCharUnicode(ch: string): boolean {
  return /[\p{L}\p{N}_]/u.test(ch);
}

function isWordCharAscii(ch: string): boolean {
  return /[a-zA-Z0-9_]/.test(ch);
}

function checkBoundary(
  haystack: string,
  pos: number,
  ascii: boolean,
): boolean {
  const isWc = ascii ? isWordCharAscii : isWordCharUnicode;
  const before = pos > 0 && isWc(haystack.charAt(pos - 1));
  const after =
    pos < haystack.length && isWc(haystack.charAt(pos));
  return before !== after;
}

function filterWholeWords(
  matches: Match[],
  haystack: string,
  ascii: boolean,
): Match[] {
  return matches.filter(
    (m) =>
      checkBoundary(haystack, m.start, ascii) &&
      checkBoundary(haystack, m.end, ascii),
  );
}

// ── Pattern normalization ───────────────────────

function normalizePatterns(patterns: PatternEntry[]): {
  strings: string[];
  names: (string | undefined)[] | null;
} {
  const strings: string[] = [];
  const names: (string | undefined)[] = [];
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

// ── Classes ─────────────────────────────────────

/**
 * Aho-Corasick automaton for multi-pattern string
 * searching.
 *
 * @throws {Error} If the automaton cannot be built
 *   (e.g. patterns exceed internal size limits).
 *
 * @example
 * ```ts
 * const ac = new AhoCorasick(["foo", "bar"]);
 * ac.findIter("foo bar");
 * // [
 * //   { pattern: 0, start: 0, end: 3,
 * //     text: "foo" },
 * //   { pattern: 1, start: 4, end: 7,
 * //     text: "bar" },
 * // ]
 * ```
 */
export class AhoCorasick {
  private _inner: NativeAhoCorasickInstance;
  private _names: (string | undefined)[] | null;
  private _jsWholeWords: boolean;

  constructor(patterns: PatternEntry[], options?: Options) {
    const { strings, names } = normalizePatterns(patterns);
    this._names = names;

    const unicodeWb = options?.unicodeBoundaries ?? true;
    this._jsWholeWords =
      !unicodeWb && (options?.wholeWords ?? false);

    const nativeOpts: Record<string, unknown> | undefined =
      options ? { ...options } : undefined;
    if (nativeOpts) {
      delete nativeOpts.unicodeBoundaries;
      if (this._jsWholeWords) {
        nativeOpts.wholeWords = false;
      }
    }

    this._inner = new binding.AhoCorasick(
      strings,
      nativeOpts,
    );
  }

  /** Number of patterns in the automaton. */
  get patternCount(): number {
    return this._inner.patternCount;
  }

  /** Returns `true` if any pattern matches. */
  isMatch(haystack: string): boolean {
    if (!this._jsWholeWords) {
      return this._inner.isMatch(haystack);
    }
    return this.findIter(haystack).length > 0;
  }

  /** Find all non-overlapping matches. */
  findIter(haystack: string): Match[] {
    let matches = unpack(
      this._inner._findIterPacked(haystack),
      haystack,
      this._names,
    );
    if (this._jsWholeWords) {
      matches = filterWholeWords(matches, haystack, true);
    }
    return matches;
  }

  /** Find all overlapping matches. */
  findOverlappingIter(haystack: string): Match[] {
    let matches = unpack(
      this._inner._findOverlappingIterPacked(haystack),
      haystack,
      this._names,
    );
    if (this._jsWholeWords) {
      matches = filterWholeWords(matches, haystack, true);
    }
    return matches;
  }

  /**
   * Replace all non-overlapping matches.
   * `replacements[i]` replaces pattern `i`.
   *
   * @throws {Error} If `replacements.length` does
   *   not equal `patternCount`.
   */
  replaceAll(
    haystack: string,
    replacements: string[],
  ): string {
    if (replacements.length !== this.patternCount) {
      throw new Error(
        `Expected ${this.patternCount} ` +
          `replacements, got ${replacements.length}`,
      );
    }
    if (!this._jsWholeWords) {
      return this._inner.replaceAll(haystack, replacements);
    }
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

  /**
   * Find matches in a `Buffer` / `Uint8Array`.
   * Returns **byte offsets** (not UTF-16).
   */
  findIterBuf(haystack: Buffer | Uint8Array): ByteMatch[] {
    return this._inner.findIterBuf(haystack);
  }

  /**
   * Check whether any pattern matches in a
   * `Buffer` / `Uint8Array`.
   */
  isMatchBuf(haystack: Buffer | Uint8Array): boolean {
    return this._inner.isMatchBuf(haystack);
  }
}

/**
 * Streaming matcher that handles chunk boundaries.
 *
 * @example
 * ```ts
 * const sm = new StreamMatcher(["needle"]);
 * for await (const chunk of stream) {
 *   for (const m of sm.write(chunk)) {
 *     console.log(`Pattern ${m.pattern} at`
 *       + ` byte ${m.start}..${m.end}`);
 *   }
 * }
 * sm.flush();
 * ```
 */
export class StreamMatcher {
  private _inner: NativeStreamMatcherInstance;

  constructor(patterns: string[], options?: Options) {
    const nativeOpts: Record<string, unknown> | undefined =
      options ? { ...options } : undefined;
    if (nativeOpts) {
      delete nativeOpts.unicodeBoundaries;
    }
    this._inner = new binding.StreamMatcher(
      patterns,
      nativeOpts,
    );
  }

  /** Feed a chunk, get matches with global byte
   *  offsets. */
  write(chunk: Buffer | Uint8Array): ByteMatch[] {
    return this._inner.write(chunk);
  }

  /** Flush remaining state. */
  flush(): ByteMatch[] {
    return this._inner.flush();
  }

  /** Reset for reuse. */
  reset(): void {
    return this._inner.reset();
  }
}
