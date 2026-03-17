use std::sync::OnceLock;

use aho_corasick::{
  AhoCorasick as RawAhoCorasick, AhoCorasickBuilder,
  AhoCorasickKind, Input,
  MatchKind as RawMatchKind,
};
use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Which match semantics to use.
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
  matches!(ch as u32,
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
fn is_word_char_at(
  haystack: &str,
  byte_pos: usize,
) -> bool {
  if byte_pos >= haystack.len() {
    return false;
  }
  // SAFETY: we only call this at valid char
  // boundaries (start/end of AC matches, which
  // are always at UTF-8 boundaries).
  let ch = haystack[byte_pos..].chars().next();
  match ch {
    Some(c) => c.is_alphanumeric() && !is_cjk(c),
    None => false,
  }
}

/// Check if the character just before `byte_pos`
/// is a word-interior character.
fn is_word_char_before(
  haystack: &str,
  byte_pos: usize,
) -> bool {
  if byte_pos == 0 {
    return false;
  }
  // Walk backwards to find the previous char.
  let ch = haystack[..byte_pos].chars().next_back();
  match ch {
    Some(c) => c.is_alphanumeric() && !is_cjk(c),
    None => false,
  }
}

/// Check if the first char of the match is CJK.
fn match_starts_with_cjk(
  haystack: &str,
  start: usize,
) -> bool {
  haystack[start..]
    .chars()
    .next()
    .map_or(false, is_cjk)
}

/// Check if the last char of the match is CJK.
fn match_ends_with_cjk(
  haystack: &str,
  end: usize,
) -> bool {
  haystack[..end]
    .chars()
    .next_back()
    .map_or(false, is_cjk)
}

/// Check if a match at [start..end) is at word
/// boundaries. CJK characters at the boundary
/// edge of the match always pass (CJK has no
/// inter-word spaces).
fn is_whole_word(
  haystack: &str,
  start: usize,
  end: usize,
) -> bool {
  let start_ok = !is_word_char_before(haystack, start)
    || match_starts_with_cjk(haystack, start);
  let end_ok = !is_word_char_at(haystack, end)
    || match_ends_with_cjk(haystack, end);
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
// - Non-ASCII: incremental translation — walk only
//   the bytes between matches. Zero allocation,
//   O(matched region) instead of O(haystack).

/// Count UTF-16 code units in a UTF-8 byte span.
/// Each UTF-8 sequence maps to either 1 or 2
/// UTF-16 code units (2 for supplementary plane,
/// i.e., 4-byte UTF-8 sequences).
fn byte_span_utf16_len(bytes: &[u8]) -> u32 {
  let mut count = 0u32;
  let mut i = 0;
  while i < bytes.len() {
    let b = bytes[i];
    if b < 0x80 {
      count += 1;
      i += 1;
    } else if b < 0xE0 {
      count += 1;
      i += 2;
    } else if b < 0xF0 {
      count += 1;
      i += 3;
    } else {
      // Supplementary plane: 2 UTF-16 code units.
      count += 2;
      i += 4;
    }
  }
  count
}

// ─── Automaton builders ───────────────────────

fn default_options() -> Options {
  Options {
    match_kind: None,
    case_insensitive: None,
    dfa: None,
    whole_words: None,
  }
}

fn resolve_match_kind(
  mk: MatchKind,
) -> RawMatchKind {
  match mk {
    MatchKind::LeftmostFirst => {
      RawMatchKind::LeftmostFirst
    }
    MatchKind::LeftmostLongest => {
      RawMatchKind::LeftmostLongest
    }
  }
}

fn build_automaton(
  patterns: &[String],
  match_kind: RawMatchKind,
  case_insensitive: bool,
  dfa: bool,
) -> std::result::Result<RawAhoCorasick, Error> {
  let mut builder = AhoCorasickBuilder::new();
  builder
    .match_kind(match_kind)
    .ascii_case_insensitive(case_insensitive);
  if dfa {
    builder.kind(Some(AhoCorasickKind::DFA));
  }
  builder.build(patterns).map_err(|e| {
    Error::from_reason(format!(
      "Failed to build automaton: {e}"
    ))
  })
}

// ─── AhoCorasick ──────────────────────────────

/// Aho-Corasick automaton for multi-pattern string
/// searching.
#[napi]
pub struct AhoCorasick {
  /// Primary automaton (leftmost semantics).
  inner: RawAhoCorasick,
  /// Lazily built overlapping automaton.
  overlapping: OnceLock<RawAhoCorasick>,
  /// Original patterns for lazy builds.
  patterns: Vec<String>,
  case_insensitive: bool,
  dfa: bool,
  whole_words: bool,
  max_pattern_byte_len: usize,
  pattern_count: u32,
}

#[napi]
impl AhoCorasick {
  /// Build an Aho-Corasick automaton from the given
  /// patterns.
  #[napi(constructor)]
  pub fn new(
    patterns: Vec<String>,
    options: Option<Options>,
  ) -> Result<Self> {
    let opts =
      options.unwrap_or_else(default_options);
    let match_kind = resolve_match_kind(
      opts
        .match_kind
        .unwrap_or(MatchKind::LeftmostFirst),
    );
    let case_insensitive =
      opts.case_insensitive.unwrap_or(false);
    let dfa = opts.dfa.unwrap_or(false);
    let whole_words =
      opts.whole_words.unwrap_or(false);
    let pattern_count = patterns.len() as u32;
    let max_pattern_byte_len = patterns
      .iter()
      .map(|p| p.len())
      .max()
      .unwrap_or(0);

    // When wholeWords is enabled, use leftmostLongest
    // so the longest match wins at each position.
    // If the longest fails the boundary check, a
    // targeted anchored fallback query finds shorter
    // alternatives at that position only.
    let effective_kind = if whole_words {
      RawMatchKind::LeftmostLongest
    } else {
      match_kind
    };

    let inner = build_automaton(
      &patterns,
      effective_kind,
      case_insensitive,
      dfa,
    )?;

    Ok(Self {
      inner,
      overlapping: OnceLock::new(),
      patterns,
      case_insensitive,
      dfa,
      whole_words,
      max_pattern_byte_len,
      pattern_count,
    })
  }

  /// Lazy overlapping automaton.
  fn overlapping_ac(&self) -> &RawAhoCorasick {
    self.overlapping.get_or_init(|| {
      build_automaton(
        &self.patterns,
        RawMatchKind::Standard,
        self.case_insensitive,
        self.dfa,
      )
      .expect("overlapping automaton build failed")
    })
  }

  /// Number of patterns in the automaton.
  #[napi(getter)]
  pub fn pattern_count(&self) -> u32 {
    self.pattern_count
  }

  /// Returns `true` if any pattern matches.
  #[napi]
  pub fn is_match(
    &self,
    haystack: String,
  ) -> bool {
    if !self.whole_words {
      return self.inner.is_match(&haystack);
    }
    // With wholeWords: find the first match that
    // passes the boundary check, same algorithm
    // as find_iter_packed but short-circuit on
    // first hit.
    let mut pos: usize = 0;
    let len = haystack.len();
    while pos < len {
      let input =
        Input::new(&haystack).range(pos..);
      let m = match self.inner.find(input) {
        Some(m) => m,
        None => return false,
      };
      if is_whole_word(
        &haystack,
        m.start(),
        m.end(),
      ) {
        return true;
      }
      // Rejected: try fallback at this position.
      if self
        .find_whole_word_at(&haystack, m.start())
        .is_some()
      {
        return true;
      }
      // Advance past rejected position.
      pos = m.start()
        + haystack[m.start()..]
          .chars()
          .next()
          .map_or(1, |c| c.len_utf8());
    }
    false
  }

  /// Find all non-overlapping matches. Returns a
  /// packed `Uint32Array` of `[pattern, start, end]`
  /// triples. The JS wrapper unpacks these into
  /// `Match` objects. Returning a typed array avoids
  /// creating thousands of JS objects across FFI.
  #[napi(js_name = "_findIterPacked")]
  pub fn find_iter_packed(
    &self,
    haystack: String,
  ) -> Uint32Array {
    if !self.whole_words {
      // No wholeWords: standard fast path.
      return self.find_iter_simple(&haystack);
    }

    // wholeWords: single-pass with targeted
    // fallback. Use manual `find()` loop so we
    // can retry at rejected positions.
    let mut packed = Vec::new();
    let mut pos: usize = 0;
    let len = haystack.len();
    let is_ascii = haystack.is_ascii();

    // For non-ASCII offset tracking.
    let bytes = haystack.as_bytes();
    let mut last_byte: usize = 0;
    let mut last_utf16: u32 = 0;

    while pos < len {
      let input = Input::new(&haystack).range(pos..);
      let m = match self.inner.find(input) {
        Some(m) => m,
        None => break,
      };

      if is_whole_word(
        &haystack,
        m.start(),
        m.end(),
      ) {
        // Fast path: accepted by wholeWords.
        if is_ascii {
          packed.push(m.pattern().as_u32());
          packed.push(m.start() as u32);
          packed.push(m.end() as u32);
        } else {
          last_utf16 += byte_span_utf16_len(
            &bytes[last_byte..m.start()],
          );
          let s = last_utf16;
          last_byte = m.start();
          last_utf16 += byte_span_utf16_len(
            &bytes[last_byte..m.end()],
          );
          let e = last_utf16;
          last_byte = m.end();
          packed.push(m.pattern().as_u32());
          packed.push(s);
          packed.push(e);
        }
        pos = m.end();
      } else {
        // Rejected: targeted anchored fallback
        // at this position only.
        if let Some((pat, start, end)) =
          self.find_whole_word_at(
            &haystack, m.start(),
          )
        {
          if is_ascii {
            packed.push(pat);
            packed.push(start as u32);
            packed.push(end as u32);
          } else {
            last_utf16 += byte_span_utf16_len(
              &bytes[last_byte..start],
            );
            let s = last_utf16;
            last_byte = start;
            last_utf16 += byte_span_utf16_len(
              &bytes[last_byte..end],
            );
            let e = last_utf16;
            last_byte = end;
            packed.push(pat);
            packed.push(s);
            packed.push(e);
          }
          pos = end;
        } else {
          // No whole-word match at this position.
          // Advance by one character.
          pos = m.start()
            + haystack[m.start()..]
              .chars()
              .next()
              .map_or(1, |c| c.len_utf8());
        }
      }
    }
    Uint32Array::new(packed)
  }

  /// Standard find_iter without wholeWords.
  fn find_iter_simple(
    &self,
    haystack: &str,
  ) -> Uint32Array {
    if haystack.is_ascii() {
      let mut packed = Vec::new();
      for m in self.inner.find_iter(haystack) {
        packed.push(m.pattern().as_u32());
        packed.push(m.start() as u32);
        packed.push(m.end() as u32);
      }
      return Uint32Array::new(packed);
    }

    let bytes = haystack.as_bytes();
    let mut packed = Vec::new();
    let mut last_byte: usize = 0;
    let mut last_utf16: u32 = 0;

    for m in self.inner.find_iter(haystack) {
      last_utf16 += byte_span_utf16_len(
        &bytes[last_byte..m.start()],
      );
      let start = last_utf16;
      last_byte = m.start();

      last_utf16 += byte_span_utf16_len(
        &bytes[last_byte..m.end()],
      );
      let end = last_utf16;
      last_byte = m.end();

      packed.push(m.pattern().as_u32());
      packed.push(start);
      packed.push(end);
    }
    Uint32Array::new(packed)
  }

  /// Targeted overlapping query at a single
  /// position. Returns the longest whole-word
  /// match starting at `start`, or None.
  ///
  /// Uses unanchored overlapping search from
  /// `start` and filters for matches starting
  /// exactly at `start`. Breaks early once
  /// matches move past the start position.
  fn find_whole_word_at(
    &self,
    haystack: &str,
    start: usize,
  ) -> Option<(u32, usize, usize)> {
    let ov = self.overlapping_ac();
    let input = Input::new(haystack).range(start..);

    let mut best: Option<(u32, usize, usize)> = None;
    let mut state =
      aho_corasick::automaton::OverlappingState::start();

    loop {
      ov.find_overlapping(input.clone(), &mut state);
      let m = match state.get_match() {
        Some(m) => m,
        None => break,
      };

      // Break once we've passed the end bound for
      // any match at `start`. The longest possible
      // match at `start` has end = start +
      // max_pattern_byte_len. Since the overlapping
      // iterator yields by ascending end position,
      // once m.end() exceeds this bound, all matches
      // at `start` have been seen.
      if m.end() > start + self.max_pattern_byte_len
      {
        break;
      }

      // Only consider matches starting at `start`.
      // Cannot break on m.start() != start because
      // the iterator yields by end position, not
      // start. A shorter match at start+1 may come
      // before a longer match at start.
      if m.start() != start {
        continue;
      }

      if is_whole_word(haystack, m.start(), m.end())
      {
        match best {
          None => {
            best = Some((
              m.pattern().as_u32(),
              m.start(),
              m.end(),
            ));
          }
          Some((_, _, prev_end))
            if m.end() > prev_end =>
          {
            best = Some((
              m.pattern().as_u32(),
              m.start(),
              m.end(),
            ));
          }
          _ => {}
        }
      }
    }
    best
  }


  /// Find all overlapping matches (packed).
  #[napi(js_name = "_findOverlappingIterPacked")]
  pub fn find_overlapping_iter_packed(
    &self,
    haystack: String,
  ) -> Uint32Array {
    let ov = self.overlapping_ac();

    let ww = self.whole_words;

    if haystack.is_ascii() {
      let mut packed = Vec::new();
      for m in ov.find_overlapping_iter(&haystack) {
        if ww
          && !is_whole_word(
            &haystack,
            m.start(),
            m.end(),
          )
        {
          continue;
        }
        packed.push(m.pattern().as_u32());
        packed.push(m.start() as u32);
        packed.push(m.end() as u32);
      }
      return Uint32Array::new(packed);
    }

    // Non-ASCII overlapping: filter at byte level
    // first, then convert remaining to UTF-16.
    let raw: Vec<_> = ov
      .find_overlapping_iter(&haystack)
      .filter(|m| {
        !ww
          || is_whole_word(
            &haystack,
            m.start(),
            m.end(),
          )
      })
      .collect();

    if raw.is_empty() {
      return Uint32Array::new(Vec::new());
    }

    // Collect unique byte offsets for translation.
    let mut offsets: Vec<usize> =
      Vec::with_capacity(raw.len() * 2);
    for m in &raw {
      offsets.push(m.start());
      offsets.push(m.end());
    }
    offsets.sort_unstable();
    offsets.dedup();

    let mut offset_map: Vec<(usize, u32)> =
      Vec::with_capacity(offsets.len());
    let mut utf16_idx: u32 = 0;
    let mut next = 0;

    for (byte_idx, ch) in haystack.char_indices() {
      while next < offsets.len()
        && offsets[next] == byte_idx
      {
        offset_map.push((byte_idx, utf16_idx));
        next += 1;
      }
      utf16_idx += ch.len_utf16() as u32;
    }
    let end_byte = haystack.len();
    while next < offsets.len()
      && offsets[next] == end_byte
    {
      offset_map.push((end_byte, utf16_idx));
      next += 1;
    }

    let lookup = |byte_off: usize| -> u32 {
      match offset_map.binary_search_by_key(
        &byte_off,
        |&(b, _)| b,
      ) {
        Ok(i) => offset_map[i].1,
        Err(_) => 0,
      }
    };

    let mut packed =
      Vec::with_capacity(raw.len() * 3);
    for m in &raw {
      packed.push(m.pattern().as_u32());
      packed.push(lookup(m.start()));
      packed.push(lookup(m.end()));
    }
    Uint32Array::new(packed)
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
    if replacements.len()
      != self.pattern_count as usize
    {
      return Err(Error::from_reason(format!(
        "Expected {} replacements, got {}",
        self.pattern_count,
        replacements.len()
      )));
    }

    if !self.whole_words {
      let refs: Vec<&str> = replacements
        .iter()
        .map(|s| s.as_str())
        .collect();
      return Ok(
        self.inner.replace_all(&haystack, &refs),
      );
    }

    // wholeWords: same single-pass + fallback as
    // findIter, but builds the result string
    // directly in Rust instead of packing offsets.
    let mut result = String::with_capacity(
      haystack.len(),
    );
    let mut pos: usize = 0;
    let len = haystack.len();

    while pos < len {
      let input =
        Input::new(&haystack).range(pos..);
      let m = match self.inner.find(input) {
        Some(m) => m,
        None => break,
      };

      if is_whole_word(
        &haystack,
        m.start(),
        m.end(),
      ) {
        result.push_str(&haystack[pos..m.start()]);
        result.push_str(
          &replacements[m.pattern().as_usize()],
        );
        pos = m.end();
      } else if let Some((pat, _, end)) =
        self.find_whole_word_at(&haystack, m.start())
      {
        result.push_str(&haystack[pos..m.start()]);
        result.push_str(
          &replacements[pat as usize],
        );
        pos = end;
      } else {
        // No whole-word match here; advance one
        // char, copying it to result.
        let ch_len = haystack[m.start()..]
          .chars()
          .next()
          .map_or(1, |c| c.len_utf8());
        result.push_str(
          &haystack[pos..m.start() + ch_len],
        );
        pos = m.start() + ch_len;
      }
    }
    // Copy remaining text.
    result.push_str(&haystack[pos..]);
    Ok(result)
  }

  /// Find matches in a `Buffer` / `Uint8Array`.
  /// Returns **byte offsets**.
  #[napi]
  pub fn find_iter_buf(
    &self,
    haystack: Buffer,
  ) -> Vec<Match> {
    let bytes: &[u8] = haystack.as_ref();
    self
      .inner
      .find_iter(bytes)
      .map(|m| Match {
        pattern: m.pattern().as_u32(),
        start: m.start() as u32,
        end: m.end() as u32,
      })
      .collect()
  }

  /// Check whether any pattern matches in a `Buffer`.
  #[napi]
  pub fn is_match_buf(
    &self,
    haystack: Buffer,
  ) -> bool {
    let bytes: &[u8] = haystack.as_ref();
    self.inner.is_match(bytes)
  }

  /// Find matches in a single chunk. Byte offsets
  /// are relative to the chunk start.
  #[napi]
  pub fn find_in_chunk(
    &self,
    chunk: Buffer,
  ) -> Vec<Match> {
    let bytes: &[u8] = chunk.as_ref();
    self
      .inner
      .find_iter(bytes)
      .map(|m| Match {
        pattern: m.pattern().as_u32(),
        start: m.start() as u32,
        end: m.end() as u32,
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
  inner: RawAhoCorasick,
  max_pattern_len: usize,
  overlap_buf: Vec<u8>,
  global_offset: usize,
}

#[napi]
impl StreamMatcher {
  /// Create a streaming matcher.
  #[napi(constructor)]
  pub fn new(
    patterns: Vec<String>,
    options: Option<Options>,
  ) -> Result<Self> {
    let opts =
      options.unwrap_or_else(default_options);
    let match_kind = resolve_match_kind(
      opts
        .match_kind
        .unwrap_or(MatchKind::LeftmostFirst),
    );
    let case_insensitive =
      opts.case_insensitive.unwrap_or(false);
    let dfa = opts.dfa.unwrap_or(false);

    let max_pattern_len = patterns
      .iter()
      .map(|p| p.len())
      .max()
      .unwrap_or(0);

    let inner = build_automaton(
      &patterns,
      match_kind,
      case_insensitive,
      dfa,
    )?;

    Ok(Self {
      inner,
      max_pattern_len,
      overlap_buf: Vec::new(),
      global_offset: 0,
    })
  }

  /// Feed a chunk and return matches with global
  /// byte offsets.
  #[napi]
  pub fn write(
    &mut self,
    chunk: Buffer,
  ) -> Vec<Match> {
    let chunk_bytes: &[u8] = chunk.as_ref();

    if self.max_pattern_len <= 1 {
      let matches = self
        .inner
        .find_iter(chunk_bytes)
        .map(|m| Match {
          pattern: m.pattern().as_u32(),
          start: (self.global_offset + m.start())
            as u32,
          end: (self.global_offset + m.end()) as u32,
        })
        .collect();
      self.global_offset += chunk_bytes.len();
      return matches;
    }

    let overlap_len = self.overlap_buf.len();
    let mut combined = Vec::with_capacity(
      overlap_len + chunk_bytes.len(),
    );
    combined.extend_from_slice(&self.overlap_buf);
    combined.extend_from_slice(chunk_bytes);

    let search_offset =
      self.global_offset - overlap_len;

    let mut matches = Vec::new();
    for m in self.inner.find_iter(&combined) {
      if m.start() < overlap_len
        && m.end() <= overlap_len
      {
        continue;
      }

      let global_start = search_offset + m.start();
      let global_end = search_offset + m.end();
      matches.push(Match {
        pattern: m.pattern().as_u32(),
        start: global_start as u32,
        end: global_end as u32,
      });
    }

    let overlap_size = (self.max_pattern_len - 1)
      .min(combined.len());
    self.overlap_buf = combined
      [combined.len() - overlap_size..]
      .to_vec();

    self.global_offset += chunk_bytes.len();
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
