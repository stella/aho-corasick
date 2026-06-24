mod case_folding;

use std::panic;

use aho_corasick::MatchKind as RawMatchKind;
use case_folding::CaseFoldingAC;
use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Convert a caught panic into a napi `Error`.
fn panic_to_napi_error(payload: &(dyn std::any::Any + Send)) -> Error {
  let msg = payload
    .downcast_ref::<&str>()
    .copied()
    .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
    .unwrap_or("unknown panic");
  Error::from_reason(format!("Rust panic: {msg}"))
}

/// Which match semantics to use.
#[derive(Clone, Copy)]
#[napi(string_enum)]
pub enum MatchKind {
  /// Report the first pattern that matches at each
  /// position (order = insertion order).
  #[napi(value = "leftmost-first")]
  LeftmostFirst,
  /// Report the longest pattern that matches at each
  /// position.
  #[napi(value = "leftmost-longest")]
  LeftmostLongest,
}

/// Options for constructing an `AhoCorasick` automaton.
#[napi(object)]
pub struct Options {
  /// Match semantics. Default: `"leftmost-first"`.
  pub match_kind: Option<MatchKind>,
  /// Case-insensitive matching. Default: `false`.
  pub case_insensitive: Option<bool>,
  /// Force DFA mode. Default: `false` (auto NFA).
  pub dfa: Option<bool>,
  /// Only match whole words. Default: `false`.
  /// Uses Unicode `is_alphanumeric()` for boundary
  /// detection (covers all scripts). CJK characters
  /// are always treated as word boundaries.
  pub whole_words: Option<bool>,
}

/// A single match returned by the search methods.
#[napi(object)]
pub struct Match {
  /// Index into the patterns array.
  pub pattern: u32,
  /// Start offset in the haystack (UTF-16 code
  /// units, matching JS `String` indexing).
  pub start: u32,
  /// End offset (exclusive, UTF-16 code units).
  pub end: u32,
}

#[derive(Clone, Copy)]
struct ByteMatchCandidate {
  pattern: u32,
  start: usize,
  end: usize,
}

const MATCH_FIELDS: usize = 3;

fn u32_from_usize(value: usize) -> u32 {
  u32::try_from(value).unwrap_or(u32::MAX)
}

fn usize_from_u32(value: u32) -> Option<usize> {
  usize::try_from(value).ok()
}

const fn packed_capacity(match_count: usize) -> usize {
  match_count.saturating_mul(MATCH_FIELDS)
}

const fn double_capacity(item_count: usize) -> usize {
  item_count.saturating_mul(2)
}

fn byte_span(bytes: &[u8], start: usize, end: usize) -> &[u8] {
  match bytes.get(start..end) {
    Some(span) => span,
    None => &[],
  }
}

fn str_span(text: &str, start: usize, end: usize) -> Result<&str> {
  text
    .get(start..end)
    .ok_or_else(|| Error::from_reason("Search produced an invalid UTF-8 span"))
}

fn replacement_for(replacements: &[String], pattern: u32) -> Result<&str> {
  let Some(index) = usize_from_u32(pattern) else {
    return Err(Error::from_reason("Pattern index does not fit usize"));
  };

  replacements.get(index).map(String::as_str).ok_or_else(|| {
    Error::from_reason(format!("Missing replacement for pattern {pattern}"))
  })
}

const fn char_utf16_len(ch: char) -> u32 {
  if ch.len_utf16() == 1 { 1 } else { 2 }
}

// ─── Word boundary detection ──────────────────
//
// Uses Unicode `char::is_alphanumeric()` which
// covers all scripts (Latin, Cyrillic, Greek,
// Arabic, Hebrew, etc.) without a hardcoded
// character list.
//
// CJK exception: CJK ideographs are alphanumeric
// per Unicode, but CJK languages don't use spaces
// between words. Every CJK character boundary is
// a valid word boundary.

/// Check if a character is CJK (ideographs,
/// hiragana, katakana, hangul).
fn is_cjk(ch: char) -> bool {
  matches!(u32::from(ch),
    0x3040..=0x309F   // Hiragana
    | 0x30A0..=0x30FF // Katakana
    | 0x3400..=0x4DBF // CJK Extension A
    | 0x4E00..=0x9FFF // CJK Unified Ideographs
    | 0xAC00..=0xD7AF // Hangul Syllables
    | 0xF900..=0xFAFF // CJK Compatibility
    | 0x20000..=0x2FA1F // CJK Extensions B-F
    | 0x30000..=0x323AF // CJK Extensions G-I
  )
}

/// Check if the character at `byte_pos` in the
/// haystack is a word-interior character (would
/// prevent a word boundary).
fn is_word_char_at(haystack: &str, byte_pos: usize) -> bool {
  if byte_pos >= haystack.len() {
    return false;
  }

  haystack
    .get(byte_pos..)
    .and_then(|tail| tail.chars().next())
    .is_some_and(|ch| ch.is_alphanumeric() && !is_cjk(ch))
}

/// Check if the character just before `byte_pos`
/// is a word-interior character.
fn is_word_char_before(haystack: &str, byte_pos: usize) -> bool {
  if byte_pos == 0 {
    return false;
  }

  haystack
    .get(..byte_pos)
    .and_then(|head| head.chars().next_back())
    .is_some_and(|ch| ch.is_alphanumeric() && !is_cjk(ch))
}

/// Check if the first char of the match is CJK.
fn match_starts_with_cjk(haystack: &str, start: usize) -> bool {
  haystack
    .get(start..)
    .and_then(|tail| tail.chars().next())
    .is_some_and(is_cjk)
}

/// Check if the last char of the match is CJK.
fn match_ends_with_cjk(haystack: &str, end: usize) -> bool {
  haystack
    .get(..end)
    .and_then(|head| head.chars().next_back())
    .is_some_and(is_cjk)
}

/// Check if a match at [start..end) is at word
/// boundaries. CJK characters at the boundary
/// edge of the match always pass (CJK has no
/// inter-word spaces).
pub(crate) fn is_whole_word(haystack: &str, start: usize, end: usize) -> bool {
  let start_ok = !is_word_char_before(haystack, start)
    || match_starts_with_cjk(haystack, start);
  let end_ok =
    !is_word_char_at(haystack, end) || match_ends_with_cjk(haystack, end);
  start_ok && end_ok
}

// ─── UTF-16 offset translation ────────────────
//
// The aho-corasick crate returns byte offsets into
// UTF-8. JS strings use UTF-16 code unit indexing.
// We need to translate, but avoid a full O(n)
// lookup table allocation.
//
// Strategy:
// - ASCII fast path: byte offset == UTF-16 offset
// - Non-ASCII: incremental translation -- walk only
//   the bytes between matches. Zero allocation,
//   O(matched region) instead of O(haystack).

/// Count UTF-16 code units in a UTF-8 byte span.
/// Each UTF-8 sequence maps to either 1 or 2
/// UTF-16 code units (2 for supplementary plane,
/// i.e., 4-byte UTF-8 sequences).
fn byte_span_utf16_len(bytes: &[u8]) -> u32 {
  let Ok(text) = std::str::from_utf8(bytes) else {
    return u32_from_usize(bytes.len());
  };

  let mut count = 0u32;
  for ch in text.chars() {
    count = count.saturating_add(char_utf16_len(ch));
  }
  count
}

fn pack_leftmost_longest_whole_word_matches(
  haystack: &str,
  candidates: Vec<ByteMatchCandidate>,
) -> Uint32Array {
  let selected = select_leftmost_longest_whole_word_matches(candidates);
  if selected.is_empty() {
    return Uint32Array::new(Vec::new());
  }

  let mut packed = Vec::with_capacity(packed_capacity(selected.len()));
  if haystack.is_ascii() {
    for m in selected {
      packed.push(m.pattern);
      packed.push(u32_from_usize(m.start));
      packed.push(u32_from_usize(m.end));
    }
    return Uint32Array::new(packed);
  }

  let bytes = haystack.as_bytes();
  let mut last_byte = 0usize;
  let mut last_utf16 = 0u32;
  for m in selected {
    last_utf16 = last_utf16.saturating_add(byte_span_utf16_len(byte_span(
      bytes, last_byte, m.start,
    )));
    let start = last_utf16;
    last_byte = m.start;
    last_utf16 = last_utf16
      .saturating_add(byte_span_utf16_len(byte_span(bytes, last_byte, m.end)));
    let end = last_utf16;
    last_byte = m.end;
    packed.push(m.pattern);
    packed.push(start);
    packed.push(end);
  }

  Uint32Array::new(packed)
}

fn select_leftmost_longest_whole_word_matches(
  mut candidates: Vec<ByteMatchCandidate>,
) -> Vec<ByteMatchCandidate> {
  if candidates.is_empty() {
    return Vec::new();
  }

  candidates.sort_unstable_by(|a, b| {
    a.start
      .cmp(&b.start)
      .then_with(|| b.end.cmp(&a.end))
      .then_with(|| a.pattern.cmp(&b.pattern))
  });

  let mut selected = Vec::new();
  let mut cursor = 0usize;
  let mut candidates = candidates.into_iter().peekable();

  while let Some(first) = candidates.next() {
    let start = first.start;
    if start < cursor {
      continue;
    }

    let mut best = first;
    while candidates
      .peek()
      .is_some_and(|candidate| candidate.start == start)
    {
      let Some(candidate) = candidates.next() else {
        break;
      };
      if candidate.end > best.end
        || (candidate.end == best.end && candidate.pattern < best.pattern)
      {
        best = candidate;
      }
    }

    selected.push(best);
    cursor = best.end;
  }

  selected
}

// ─── Automaton builders ───────────────────────

const fn default_options() -> Options {
  Options {
    match_kind: None,
    case_insensitive: None,
    dfa: None,
    whole_words: None,
  }
}

const fn resolve_match_kind(mk: MatchKind) -> RawMatchKind {
  match mk {
    MatchKind::LeftmostFirst => RawMatchKind::LeftmostFirst,
    MatchKind::LeftmostLongest => RawMatchKind::LeftmostLongest,
  }
}

// ─── AhoCorasick ──────────────────────────────

/// Aho-Corasick automaton for multi-pattern string
/// searching.
#[napi]
pub struct AhoCorasick {
  search: CaseFoldingAC,
  whole_words: bool,
  pattern_count: u32,
}

#[napi]
#[allow(clippy::needless_pass_by_value)]
impl AhoCorasick {
  /// Build an Aho-Corasick automaton from the given
  /// patterns.
  #[napi(constructor)]
  pub fn new(patterns: Vec<String>, options: Option<Options>) -> Result<Self> {
    panic::catch_unwind(|| Self::new_inner(patterns, options))
      .unwrap_or_else(|e| Err(panic_to_napi_error(e.as_ref())))
  }

  fn new_inner(
    patterns: Vec<String>,
    options: Option<Options>,
  ) -> Result<Self> {
    let opts = options.unwrap_or_else(default_options);
    let match_kind =
      resolve_match_kind(opts.match_kind.unwrap_or(MatchKind::LeftmostFirst));
    let case_insensitive = opts.case_insensitive.unwrap_or(false);
    let dfa = opts.dfa.unwrap_or(false);
    let whole_words = opts.whole_words.unwrap_or(false);
    let pattern_count = u32_from_usize(patterns.len());

    // With wholeWords, build a Standard automaton and
    // select leftmost-longest matches after boundary
    // filtering. This keeps construction to one
    // automaton instead of a leftmost primary plus a
    // lazy overlapping fallback.
    let effective_kind = if whole_words {
      RawMatchKind::Standard
    } else {
      match_kind
    };

    let search =
      CaseFoldingAC::build(patterns, effective_kind, case_insensitive, dfa)?;

    Ok(Self {
      search,
      whole_words,
      pattern_count,
    })
  }

  /// Number of patterns in the automaton.
  #[napi(getter)]
  #[must_use]
  pub const fn pattern_count(&self) -> u32 {
    self.pattern_count
  }

  /// Returns `true` if any pattern matches.
  #[napi]
  pub fn is_match(&self, haystack: String) -> Result<bool> {
    if !self.whole_words {
      let prep = self.search.prepare(&haystack);
      return Ok(self.search.is_match_str(&prep));
    }
    let prep = self.search.prepare(&haystack);
    for m in self.search.overlapping_find_iter(&prep)? {
      let os = prep.orig_pos(m.start());
      let oe = prep.orig_pos(m.end());
      if is_whole_word(&haystack, os, oe) {
        return Ok(true);
      }
    }
    Ok(false)
  }

  /// Find all non-overlapping matches. Returns a
  /// packed `Uint32Array` of `[pattern, start, end]`
  /// triples. The JS wrapper unpacks these into
  /// `Match` objects. Returning a typed array avoids
  /// creating thousands of JS objects across FFI.
  #[napi(js_name = "_findIterPacked")]
  pub fn find_iter_packed(&self, haystack: String) -> Result<Uint32Array> {
    if !self.whole_words {
      return Ok(self.find_iter_simple(&haystack));
    }

    let prep = self.search.prepare(&haystack);
    let mut candidates = Vec::new();
    for m in self.search.overlapping_find_iter(&prep)? {
      let os = prep.orig_pos(m.start());
      let oe = prep.orig_pos(m.end());
      if is_whole_word(&haystack, os, oe) {
        candidates.push(ByteMatchCandidate {
          pattern: m.pattern().as_u32(),
          start: os,
          end: oe,
        });
      }
    }

    Ok(pack_leftmost_longest_whole_word_matches(
      &haystack, candidates,
    ))
  }

  /// Standard `find_iter` without wholeWords.
  fn find_iter_simple(&self, haystack: &str) -> Uint32Array {
    let prep = self.search.prepare(haystack);

    if haystack.is_ascii() {
      let mut packed = Vec::new();
      for m in self.search.find_iter(&prep) {
        let os = prep.orig_pos(m.start());
        let oe = prep.orig_pos(m.end());
        packed.push(m.pattern().as_u32());
        packed.push(u32_from_usize(os));
        packed.push(u32_from_usize(oe));
      }
      return Uint32Array::new(packed);
    }

    // Non-ASCII: need UTF-16 conversion on
    // ORIGINAL text
    let bytes = haystack.as_bytes();
    let mut packed = Vec::new();
    let mut last_byte: usize = 0;
    let mut last_utf16: u32 = 0;

    for m in self.search.find_iter(&prep) {
      let os = prep.orig_pos(m.start());
      let oe = prep.orig_pos(m.end());

      last_utf16 = last_utf16
        .saturating_add(byte_span_utf16_len(byte_span(bytes, last_byte, os)));
      let start = last_utf16;
      last_byte = os;

      last_utf16 = last_utf16
        .saturating_add(byte_span_utf16_len(byte_span(bytes, last_byte, oe)));
      let end = last_utf16;
      last_byte = oe;

      packed.push(m.pattern().as_u32());
      packed.push(start);
      packed.push(end);
    }
    Uint32Array::new(packed)
  }

  /// Find all overlapping matches (packed).
  #[napi(js_name = "_findOverlappingIterPacked")]
  pub fn find_overlapping_iter_packed(
    &self,
    haystack: String,
  ) -> Result<Uint32Array> {
    let ww = self.whole_words;
    let prep = self.search.prepare(&haystack);

    if haystack.is_ascii() {
      let mut packed = Vec::new();
      for m in self.search.overlapping_find_iter(&prep)? {
        let os = prep.orig_pos(m.start());
        let oe = prep.orig_pos(m.end());
        if ww && !is_whole_word(&haystack, os, oe) {
          continue;
        }
        packed.push(m.pattern().as_u32());
        packed.push(u32_from_usize(os));
        packed.push(u32_from_usize(oe));
      }
      return Ok(Uint32Array::new(packed));
    }

    let raw: Vec<_> = self
      .search
      .overlapping_find_iter(&prep)?
      .filter(|m| {
        let os = prep.orig_pos(m.start());
        let oe = prep.orig_pos(m.end());
        !ww || is_whole_word(&haystack, os, oe)
      })
      .collect();

    if raw.is_empty() {
      return Ok(Uint32Array::new(Vec::new()));
    }

    // Collect unique byte offsets for translation.
    // Map back to original positions first.
    let mut offsets: Vec<usize> =
      Vec::with_capacity(double_capacity(raw.len()));
    for m in &raw {
      let os = prep.orig_pos(m.start());
      let oe = prep.orig_pos(m.end());
      offsets.push(os);
      offsets.push(oe);
    }
    offsets.sort_unstable();
    offsets.dedup();

    let mut offset_map: Vec<(usize, u32)> = Vec::with_capacity(offsets.len());
    let mut utf16_idx: u32 = 0;
    let mut offsets = offsets.into_iter().peekable();

    for (byte_idx, ch) in haystack.char_indices() {
      while offsets.peek().is_some_and(|offset| *offset == byte_idx) {
        offset_map.push((byte_idx, utf16_idx));
        _ = offsets.next();
      }
      utf16_idx = utf16_idx.saturating_add(char_utf16_len(ch));
    }
    let end_byte = haystack.len();
    while offsets.peek().is_some_and(|offset| *offset == end_byte) {
      offset_map.push((end_byte, utf16_idx));
      _ = offsets.next();
    }

    let lookup = |byte_off: usize| -> u32 {
      offset_map
        .binary_search_by_key(&byte_off, |&(b, _)| b)
        .map_or(0, |i| offset_map.get(i).map_or(0, |(_, value)| *value))
    };

    let mut packed = Vec::with_capacity(packed_capacity(raw.len()));
    for m in &raw {
      let os = prep.orig_pos(m.start());
      let oe = prep.orig_pos(m.end());
      packed.push(m.pattern().as_u32());
      packed.push(lookup(os));
      packed.push(lookup(oe));
    }
    Ok(Uint32Array::new(packed))
  }

  /// Replace all non-overlapping matches.
  ///
  /// `replacements[i]` replaces pattern `i`.
  #[napi]
  pub fn replace_all(
    &self,
    haystack: String,
    replacements: Vec<String>,
  ) -> Result<String> {
    let Some(expected_replacements) = usize_from_u32(self.pattern_count) else {
      return Err(Error::from_reason(
        "Pattern count does not fit this platform",
      ));
    };

    if replacements.len() != expected_replacements {
      return Err(Error::from_reason(format!(
        "Expected {} replacements, got {}",
        self.pattern_count,
        replacements.len()
      )));
    }

    let prep = self.search.prepare(&haystack);

    if !self.whole_words {
      // Build result by finding matches on prepared
      // text and replacing spans in the original.
      let mut result = String::with_capacity(haystack.len());
      let mut last = 0usize;
      for m in self.search.find_iter(&prep) {
        let os = prep.orig_pos(m.start());
        let oe = prep.orig_pos(m.end());
        result.push_str(str_span(&haystack, last, os)?);
        result.push_str(replacement_for(&replacements, m.pattern().as_u32())?);
        last = oe;
      }
      result.push_str(str_span(&haystack, last, haystack.len())?);
      return Ok(result);
    }

    let mut candidates = Vec::new();
    for m in self.search.overlapping_find_iter(&prep)? {
      let os = prep.orig_pos(m.start());
      let oe = prep.orig_pos(m.end());
      if is_whole_word(&haystack, os, oe) {
        candidates.push(ByteMatchCandidate {
          pattern: m.pattern().as_u32(),
          start: os,
          end: oe,
        });
      }
    }

    let selected = select_leftmost_longest_whole_word_matches(candidates);
    let mut result = String::with_capacity(haystack.len());
    let mut last_orig = 0usize;
    for m in selected {
      result.push_str(str_span(&haystack, last_orig, m.start)?);
      result.push_str(replacement_for(&replacements, m.pattern)?);
      last_orig = m.end;
    }
    result.push_str(str_span(&haystack, last_orig, haystack.len())?);
    Ok(result)
  }

  /// Find matches in a `Buffer` / `Uint8Array`.
  /// Returns **byte offsets**.
  #[napi]
  #[must_use]
  pub fn find_iter_buf(&self, haystack: Buffer) -> Vec<Match> {
    let bytes: &[u8] = haystack.as_ref();
    let prep = self.search.prepare_bytes(bytes);
    self
      .search
      .find_iter_bytes(&prep)
      .map(|m| Match {
        pattern: m.pattern().as_u32(),
        start: u32_from_usize(prep.orig_pos(m.start())),
        end: u32_from_usize(prep.orig_pos(m.end())),
      })
      .collect()
  }

  /// Zero-copy packed search on a `Buffer`.
  /// Returns `Uint32Array` of `[pattern, start, end]`
  /// triples with **byte offsets**.
  #[napi(js_name = "_findIterPackedBuf")]
  #[must_use]
  pub fn find_iter_packed_buf(&self, haystack: Buffer) -> Uint32Array {
    let bytes: &[u8] = haystack.as_ref();
    let prep = self.search.prepare_bytes(bytes);
    let mut packed = Vec::new();
    for m in self.search.find_iter_bytes(&prep) {
      packed.push(m.pattern().as_u32());
      packed.push(u32_from_usize(prep.orig_pos(m.start())));
      packed.push(u32_from_usize(prep.orig_pos(m.end())));
    }
    Uint32Array::new(packed)
  }

  /// Check whether any pattern matches in a `Buffer`.
  #[napi]
  #[must_use]
  pub fn is_match_buf(&self, haystack: Buffer) -> bool {
    let bytes: &[u8] = haystack.as_ref();
    let prep = self.search.prepare_bytes(bytes);
    self.search.is_match_bytes_prep(&prep)
  }

  /// Find matches in a single chunk. Byte offsets
  /// are relative to the chunk start.
  #[napi]
  #[must_use]
  pub fn find_in_chunk(&self, chunk: Buffer) -> Vec<Match> {
    let bytes: &[u8] = chunk.as_ref();
    let prep = self.search.prepare_bytes(bytes);
    self
      .search
      .find_iter_bytes(&prep)
      .map(|m| Match {
        pattern: m.pattern().as_u32(),
        start: u32_from_usize(prep.orig_pos(m.start())),
        end: u32_from_usize(prep.orig_pos(m.end())),
      })
      .collect()
  }
}

// ─── StreamMatcher ────────────────────────────

/// Streaming matcher that handles chunk boundaries.
///
/// Feed chunks via `write()` and collect matches.
/// Internally buffers the overlap region between
/// chunks so cross-boundary matches are found.
///
/// Operates on raw bytes (UTF-8). Offsets are global
/// byte offsets across all chunks.
#[napi]
pub struct StreamMatcher {
  search: CaseFoldingAC,
  max_pattern_len: usize,
  overlap_buf: Vec<u8>,
  global_offset: usize,
}

#[napi]
#[allow(clippy::needless_pass_by_value)]
impl StreamMatcher {
  /// Create a streaming matcher.
  #[napi(constructor)]
  pub fn new(patterns: Vec<String>, options: Option<Options>) -> Result<Self> {
    panic::catch_unwind(|| Self::new_inner(patterns, options))
      .unwrap_or_else(|e| Err(panic_to_napi_error(e.as_ref())))
  }

  fn new_inner(
    patterns: Vec<String>,
    options: Option<Options>,
  ) -> Result<Self> {
    let opts = options.unwrap_or_else(default_options);
    let match_kind =
      resolve_match_kind(opts.match_kind.unwrap_or(MatchKind::LeftmostFirst));
    let case_insensitive = opts.case_insensitive.unwrap_or(false);
    let dfa = opts.dfa.unwrap_or(false);

    let max_pattern_len = patterns.iter().map(String::len).max().unwrap_or(0);

    let search =
      CaseFoldingAC::build(patterns, match_kind, case_insensitive, dfa)?;

    Ok(Self {
      search,
      max_pattern_len,
      overlap_buf: Vec::new(),
      global_offset: 0,
    })
  }

  /// Feed a chunk and return matches with global
  /// byte offsets.
  #[napi]
  pub fn write(&mut self, chunk: Buffer) -> Vec<Match> {
    let chunk_bytes: &[u8] = chunk.as_ref();

    if self.max_pattern_len <= 1 {
      let prep = self.search.prepare_bytes(chunk_bytes);
      let matches = self
        .search
        .find_iter_bytes(&prep)
        .map(|m| Match {
          pattern: m.pattern().as_u32(),
          start: u32_from_usize(
            self.global_offset.saturating_add(prep.orig_pos(m.start())),
          ),
          end: u32_from_usize(
            self.global_offset.saturating_add(prep.orig_pos(m.end())),
          ),
        })
        .collect();
      self.global_offset = self.global_offset.saturating_add(chunk_bytes.len());
      return matches;
    }

    let overlap_len = self.overlap_buf.len();
    let mut combined =
      Vec::with_capacity(overlap_len.saturating_add(chunk_bytes.len()));
    combined.extend_from_slice(&self.overlap_buf);
    combined.extend_from_slice(chunk_bytes);

    let search_offset = self.global_offset.saturating_sub(overlap_len);
    let prep = self.search.prepare_bytes(&combined);

    let mut matches = Vec::new();
    for m in self.search.find_iter_bytes(&prep) {
      let os = prep.orig_pos(m.start());
      let oe = prep.orig_pos(m.end());
      if os < overlap_len && oe <= overlap_len {
        continue;
      }
      matches.push(Match {
        pattern: m.pattern().as_u32(),
        start: u32_from_usize(search_offset.saturating_add(os)),
        end: u32_from_usize(search_offset.saturating_add(oe)),
      });
    }

    // Align overlap cut to UTF-8 char boundary
    let overlap_size =
      self.max_pattern_len.saturating_sub(1).min(combined.len());
    let mut cut = combined.len().saturating_sub(overlap_size);
    while cut < combined.len()
      && combined.get(cut).is_some_and(|byte| (byte & 0xC0) == 0x80)
    {
      cut = cut.saturating_add(1);
    }
    self.overlap_buf =
      combined.get(cut..).map_or_else(Vec::new, <[u8]>::to_vec);
    self.global_offset = self.global_offset.saturating_add(chunk_bytes.len());
    matches
  }

  /// Flush remaining state. Call after the last
  /// chunk.
  #[napi]
  pub fn flush(&mut self) -> Vec<Match> {
    self.overlap_buf.clear();
    self.global_offset = 0;
    Vec::new()
  }

  /// Reset for reuse with new input.
  #[napi]
  pub fn reset(&mut self) {
    self.overlap_buf.clear();
    self.global_offset = 0;
  }
}
