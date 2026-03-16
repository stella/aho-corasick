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
};

/** A single match result. */
export type Match = {
  /** Index into the patterns array. */
  pattern: number;
  /** Start UTF-16 code unit offset (compatible
   *  with `String.prototype.slice()`). */
  start: number;
  /** End offset (exclusive). */
  end: number;
};

/**
 * Aho-Corasick automaton for multi-pattern string
 * searching.
 */
export declare class AhoCorasick {
  constructor(
    patterns: string[],
    options?: Options,
  );

  /** Number of patterns in the automaton. */
  get patternCount(): number;

  /** Returns `true` if any pattern matches. */
  isMatch(haystack: string): boolean;

  /** Find all non-overlapping matches. */
  findIter(haystack: string): Match[];

  /**
   * Same as `findIter` but returns a packed
   * `Uint32Array` of `[pattern, start, end, ...]`
   * triples instead of `Match` objects.
   *
   * Use for large inputs where millions of JS
   * objects would spike memory. Iterate with:
   * ```ts
   * const packed = ac.findIterPacked(text);
   * for (let i = 0; i < packed.length; i += 3) {
   *   const pattern = packed[i];
   *   const start = packed[i + 1];
   *   const end = packed[i + 2];
   * }
   * ```
   */
  findIterPacked(haystack: string): Uint32Array;

  /** Find all overlapping matches. */
  findOverlappingIter(haystack: string): Match[];

  /**
   * Packed variant of `findOverlappingIter`.
   */
  findOverlappingIterPacked(
    haystack: string,
  ): Uint32Array;

  /**
   * Replace all non-overlapping matches.
   * `replacements[i]` replaces pattern `i`.
   */
  replaceAll(
    haystack: string,
    replacements: string[],
  ): string;

  /**
   * Find matches in a `Buffer` / `Uint8Array`.
   * Returns **byte offsets**.
   */
  findIterBuf(haystack: Buffer): Match[];

  /** Check for match in a `Buffer`. */
  isMatchBuf(haystack: Buffer): boolean;

  /** Find matches in a chunk (byte offsets). */
  findInChunk(chunk: Buffer): Match[];
}

/**
 * Streaming matcher that handles chunk boundaries.
 */
export declare class StreamMatcher {
  constructor(
    patterns: string[],
    options?: Options,
  );

  /** Feed a chunk, get global byte offset matches. */
  write(chunk: Buffer): Match[];

  /** Flush remaining state. */
  flush(): Match[];

  /** Reset for reuse. */
  reset(): void;
}
