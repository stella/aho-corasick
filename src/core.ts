/* Shared core: types, helpers, and classes that
 * use a late-bound native backend (NAPI-RS or WASM).
 * Call initBinding() before constructing classes. */

// ── Native binding types ────────────────────────

export type NativeBinding = {
  AhoCorasick: new (
    patterns: string[],
    options?: Record<string, unknown>,
  ) => NativeAhoCorasickInstance;
  prepareAhoCorasick(
    patterns: string[],
    options?: Record<string, unknown>,
  ): Buffer;
  ahoCorasickFromPrepared(
    bytes: Buffer | Uint8Array,
  ): NativeAhoCorasickInstance;
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
  _findIterPackedBuf(
    haystack: Buffer | Uint8Array,
  ): Uint32Array;
  findIterBuf(haystack: Buffer | Uint8Array): ByteMatch[];
  isMatchBuf(haystack: Buffer | Uint8Array): boolean;
  toPrepared(): Buffer;
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

export type PreparedAhoCorasick = {
  bytes: Buffer | Uint8Array;
  names?: readonly (string | undefined)[];
};

// ── Unpack helper ───────────────────────────────

function unpack(
  packed: Uint32Array,
  haystack: string,
  names: (string | undefined)[] | null,
): Match[] {
  const len = packed.length;
  // `Math.floor` is defensive: if the native side
  // ever returned a length that is not a multiple of
  // 3, `new Array(non-integer)` would throw a cryptic
  // `RangeError` before the per-triple guard could
  // surface a descriptive error.
  // eslint-disable-next-line unicorn/no-new-array
  const matches = new Array<Match>(Math.floor(len / 3));
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

/** Unpack a buffer-mode packed result. Offsets are
 *  bytes (the buffer path does not translate to
 *  UTF-16 code units), and `ByteMatch` has no
 *  `text` field. */
function unpackBuf(packed: Uint32Array): ByteMatch[] {
  const len = packed.length;
  // `Math.floor` is defensive: if the native side
  // ever returned a length that is not a multiple of
  // 3, `new Array(non-integer)` would throw a cryptic
  // `RangeError` before the per-triple guard could
  // surface a descriptive error.
  // eslint-disable-next-line unicorn/no-new-array
  const matches = new Array<ByteMatch>(Math.floor(len / 3));
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
    matches[j] = { pattern: idx, start, end };
  }
  return matches;
}

// ── Pattern normalization ───────────────────────

function normalizePatterns(patterns: readonly unknown[]): {
  strings: string[];
  names: (string | undefined)[] | null;
} {
  if (!Array.isArray(patterns)) {
    throw new TypeError("Patterns must be an array");
  }

  const strings: string[] = [];
  const names: (string | undefined)[] = [];
  let hasNames = false;

  for (const p of patterns) {
    if (typeof p === "string") {
      strings.push(p);
      names.push(undefined);
      continue;
    }

    if (
      typeof p !== "object" ||
      p === null ||
      !("pattern" in p) ||
      typeof p.pattern !== "string"
    ) {
      throw new TypeError(
        "Pattern must be a string or " +
          "{ pattern: string; name?: string }",
      );
    }

    strings.push(p.pattern);
    if (!("name" in p) || p.name === undefined) {
      names.push(undefined);
      continue;
    }

    if (typeof p.name !== "string") {
      throw new TypeError("Pattern name must be a string");
    }

    hasNames = true;
    names.push(p.name);
  }

  return { strings, names: hasNames ? names : null };
}

function normalizeOptions(
  options: Options | undefined,
): Record<string, unknown> | undefined {
  return options ? { ...options } : undefined;
}

function normalizePrepared(
  prepared: PreparedAhoCorasick | Buffer | Uint8Array,
  names?: readonly (string | undefined)[],
): PreparedAhoCorasick {
  if (prepared instanceof Uint8Array) {
    return names
      ? { bytes: prepared, names }
      : { bytes: prepared };
  }
  return prepared;
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

  constructor(patterns: PatternEntry[], options?: Options) {
    const { strings, names } = normalizePatterns(patterns);
    this._names = names;

    this._inner = new binding.AhoCorasick(
      strings,
      normalizeOptions(options),
    );
  }

  static prepare(
    patterns: PatternEntry[],
    options?: Options,
  ): PreparedAhoCorasick {
    const { strings, names } = normalizePatterns(patterns);
    const bytes = binding.prepareAhoCorasick(
      strings,
      normalizeOptions(options),
    );
    return names ? { bytes, names } : { bytes };
  }

  static fromPrepared(
    prepared: PreparedAhoCorasick | Buffer | Uint8Array,
    names?: readonly (string | undefined)[],
  ): AhoCorasick {
    const normalized = normalizePrepared(prepared, names);
    const instance = Object.create(
      AhoCorasick.prototype,
    ) as AhoCorasick;
    instance._inner = binding.ahoCorasickFromPrepared(
      normalized.bytes,
    );
    instance._names = normalized.names
      ? Array.from(normalized.names)
      : null;
    return instance;
  }

  /** Number of patterns in the automaton. */
  get patternCount(): number {
    return this._inner.patternCount;
  }

  /** Returns `true` if any pattern matches. */
  isMatch(haystack: string): boolean {
    return this._inner.isMatch(haystack);
  }

  /** Find all non-overlapping matches. */
  findIter(haystack: string): Match[] {
    return unpack(
      this._inner._findIterPacked(haystack),
      haystack,
      this._names,
    );
  }

  /** Find all overlapping matches. */
  findOverlappingIter(haystack: string): Match[] {
    return unpack(
      this._inner._findOverlappingIterPacked(haystack),
      haystack,
      this._names,
    );
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
    return this._inner.replaceAll(haystack, replacements);
  }

  toPrepared(): PreparedAhoCorasick {
    const bytes = this._inner.toPrepared();
    return this._names
      ? { bytes, names: this._names }
      : { bytes };
  }

  /**
   * Find matches in a `Buffer` / `Uint8Array`.
   * Returns **byte offsets** (not UTF-16).
   */
  findIterBuf(haystack: Buffer | Uint8Array): ByteMatch[] {
    return unpackBuf(
      this._inner._findIterPackedBuf(haystack),
    );
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
    this._inner = new binding.StreamMatcher(
      patterns,
      normalizeOptions(options),
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
