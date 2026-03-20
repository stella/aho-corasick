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
export declare class AhoCorasick {
  constructor(
    patterns: PatternEntry[],
    options?: Options,
  );

  /** Number of patterns in the automaton. */
  get patternCount(): number;

  /** Returns `true` if any pattern matches. */
  isMatch(haystack: string): boolean;

  /** Find all non-overlapping matches. */
  findIter(haystack: string): Match[];

  /** Find all overlapping matches. */
  findOverlappingIter(haystack: string): Match[];

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
  ): string;

  /**
   * Find matches in a `Buffer` / `Uint8Array`.
   * Returns **byte offsets** (not UTF-16).
   *
   * Note: `wholeWords` has no effect on Buffer
   * methods. Use string methods for whole-word
   * filtering.
   */
  findIterBuf(haystack: Buffer | Uint8Array): ByteMatch[];

  /**
   * Check whether any pattern matches in a
   * `Buffer` / `Uint8Array`.
   *
   * Note: `wholeWords` has no effect on Buffer
   * methods. Use string methods for whole-word
   * filtering.
   */
  isMatchBuf(haystack: Buffer | Uint8Array): boolean;
}

/**
 * Streaming matcher that handles chunk boundaries.
 *
 * Feed `Buffer` / `Uint8Array` chunks via
 * `write()` and collect
 * matches. Offsets are **global byte offsets**
 * across all chunks written since construction or
 * last `reset()`.
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
 * sm.flush(); // finalize stream state
 * ```
 */
export declare class StreamMatcher {
  constructor(patterns: string[], options?: Options);

  /**
   * Feed a chunk, get matches with global byte
   * offsets.
   */
  write(chunk: Buffer | Uint8Array): ByteMatch[];

  /** Flush remaining state. */
  flush(): ByteMatch[];

  /** Reset for reuse. */
  reset(): void;
}
