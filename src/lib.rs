mod case_folding;

use std::panic;

use aho_corasick::MatchKind as RawMatchKind;
use case_folding::CaseFoldingAC;
use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Convert a caught panic into a napi `Error`.
fn panic_to_napi_error(
  payload: Box<dyn std::any::Any + Send>,
) -> Error {
  let msg = payload
    .downcast_ref::<&str>()
    .copied()
    .or_else(|| {
      payload.downcast_ref::<String>().map(|s| s.as_str())
    })
    .unwrap_or("unknown panic");
  Error::from_reason(format!("Rust panic: {msg}"))
}

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
  haystack[start..].chars().next().is_some_and(is_cjk)
}

/// Check if the last char of the match is CJK.
fn match_ends_with_cjk(haystack: &str, end: usize) -> bool {
  haystack[..end].chars().next_back().is_some_and(is_cjk)
}

/// Check if a match at [start..end) is at word
/// boundaries. CJK characters at the boundary
/// edge of the match always pass (CJK has no
/// inter-word spaces).
pub(crate) fn is_whole_word(
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
// - Non-ASCII: incremental translation -- walk only
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

fn resolve_match_kind(mk: MatchKind) -> RawMatchKind {
  match mk {
    MatchKind::LeftmostFirst => RawMatchKind::LeftmostFirst,
    MatchKind::LeftmostLongest => {
      RawMatchKind::LeftmostLongest
    }
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
impl AhoCorasick {
  /// Build an Aho-Corasick automaton from the given
  /// patterns.
  #[napi(constructor)]
  pub fn new(
    patterns: Vec<String>,
    options: Option<Options>,
  ) -> Result<Self> {
    panic::catch_unwind(|| {
      Self::new_inner(patterns, options)
    })
    .unwrap_or_else(|e| Err(panic_to_napi_error(e)))
  }

  fn new_inner(
    patterns: Vec<String>,
    options: Option<Options>,
  ) -> Result<Self> {
    let opts = options.unwrap_or_else(default_options);
    let match_kind = resolve_match_kind(
      opts.match_kind.unwrap_or(MatchKind::LeftmostFirst),
    );
    let case_insensitive =
      opts.case_insensitive.unwrap_or(false);
    let dfa = opts.dfa.unwrap_or(false);
    let whole_words = opts.whole_words.unwrap_or(false);
    let pattern_count = patterns.len() as u32;

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

    let search = CaseFoldingAC::build(
      &patterns,
      effective_kind,
      case_insensitive,
      dfa,
    )?;

    Ok(Self {
      search,
      whole_words,
      pattern_count,
    })
  }

  /// Number of patterns in the automaton.
  #[napi(getter)]
  pub fn pattern_count(&self) -> u32 {
    self.pattern_count
  }

  /// Returns `true` if any pattern matches.
  #[napi]
  pub fn is_match(&self, haystack: String) -> bool {
    if !self.whole_words {
      let prep = self.search.prepare(&haystack);
      return self.search.is_match_str(&prep);
    }
    // With wholeWords: search prepared text, check
    // boundaries on original.
    let prep = self.search.prepare(&haystack);
    let search_text = prep.search_text();
    let mut pos: usize = 0;
    let len = search_text.len();
    while pos < len {
      let Some(m) =
        self.search.find_at(&prep, pos..len)
      else {
        return false;
      };
      let os = prep.orig_pos(m.start());
      let oe = prep.orig_pos(m.end());
      if is_whole_word(&haystack, os, oe) {
        return true;
      }
      if self
        .search
        .find_whole_word_at(
          &prep,
          m.start(),
          &haystack,
          |p| prep.orig_pos(p),
        )
        .is_some()
      {
        return true;
      }
      pos = m.start()
        + search_text[m.start()..]
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
      return self.find_iter_simple(&haystack);
    }

    let prep = self.search.prepare(&haystack);
    let search_text = prep.search_text();

    let mut packed = Vec::new();
    let mut pos: usize = 0;
    let len = search_text.len();
    let is_ascii = haystack.is_ascii();
    let bytes = haystack.as_bytes();
    let mut last_byte: usize = 0;
    let mut last_utf16: u32 = 0;

    while pos < len {
      let Some(m) =
        self.search.find_at(&prep, pos..len)
      else {
        break;
      };

      let os = prep.orig_pos(m.start());
      let oe = prep.orig_pos(m.end());

      if is_whole_word(&haystack, os, oe) {
        if is_ascii {
          packed.push(m.pattern().as_u32());
          packed.push(os as u32);
          packed.push(oe as u32);
        } else {
          last_utf16 += byte_span_utf16_len(
            &bytes[last_byte..os],
          );
          let s = last_utf16;
          last_byte = os;
          last_utf16 += byte_span_utf16_len(
            &bytes[last_byte..oe],
          );
          let e = last_utf16;
          last_byte = oe;
          packed.push(m.pattern().as_u32());
          packed.push(s);
          packed.push(e);
        }
        pos = m.end();
      } else {
        if let Some((pat, _, end)) = self
          .search
          .find_whole_word_at(
            &prep,
            m.start(),
            &haystack,
            |p| prep.orig_pos(p),
          )
        {
          let fos = prep.orig_pos(m.start());
          let foe = prep.orig_pos(end);

          if !is_whole_word(&haystack, fos, foe) {
            pos = m.start()
              + search_text[m.start()..]
                .chars()
                .next()
                .map_or(1, |c| c.len_utf8());
            continue;
          }

          if is_ascii {
            packed.push(pat);
            packed.push(fos as u32);
            packed.push(foe as u32);
          } else {
            last_utf16 += byte_span_utf16_len(
              &bytes[last_byte..fos],
            );
            let s = last_utf16;
            last_byte = fos;
            last_utf16 += byte_span_utf16_len(
              &bytes[last_byte..foe],
            );
            let e = last_utf16;
            last_byte = foe;
            packed.push(pat);
            packed.push(s);
            packed.push(e);
          }
          pos = end;
        } else {
          pos = m.start()
            + search_text[m.start()..]
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
    let prep = self.search.prepare(haystack);

    if haystack.is_ascii() {
      let mut packed = Vec::new();
      for m in self.search.find_iter(&prep) {
        let os = prep.orig_pos(m.start());
        let oe = prep.orig_pos(m.end());
        packed.push(m.pattern().as_u32());
        packed.push(os as u32);
        packed.push(oe as u32);
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

      last_utf16 += byte_span_utf16_len(
        &bytes[last_byte..os],
      );
      let start = last_utf16;
      last_byte = os;

      last_utf16 += byte_span_utf16_len(
        &bytes[last_byte..oe],
      );
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
  ) -> Uint32Array {
    let ww = self.whole_words;
    let prep = self.search.prepare(&haystack);

    if haystack.is_ascii() {
      let mut packed = Vec::new();
      for m in self.search.overlapping_find_iter(&prep) {
        let os = prep.orig_pos(m.start());
        let oe = prep.orig_pos(m.end());
        if ww && !is_whole_word(&haystack, os, oe) {
          continue;
        }
        packed.push(m.pattern().as_u32());
        packed.push(os as u32);
        packed.push(oe as u32);
      }
      return Uint32Array::new(packed);
    }

    let raw: Vec<_> = self
      .search
      .overlapping_find_iter(&prep)
      .filter(|m| {
        let os = prep.orig_pos(m.start());
        let oe = prep.orig_pos(m.end());
        !ww || is_whole_word(&haystack, os, oe)
      })
      .collect();

    if raw.is_empty() {
      return Uint32Array::new(Vec::new());
    }

    // Collect unique byte offsets for translation.
    // Map back to original positions first.
    let mut offsets: Vec<usize> =
      Vec::with_capacity(raw.len() * 2);
    for m in &raw {
      let os = prep.orig_pos(m.start());
      let oe = prep.orig_pos(m.end());
      offsets.push(os);
      offsets.push(oe);
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
      match offset_map
        .binary_search_by_key(&byte_off, |&(b, _)| b)
      {
        Ok(i) => offset_map[i].1,
        Err(_) => 0,
      }
    };

    let mut packed = Vec::with_capacity(raw.len() * 3);
    for m in &raw {
      let os = prep.orig_pos(m.start());
      let oe = prep.orig_pos(m.end());
      packed.push(m.pattern().as_u32());
      packed.push(lookup(os));
      packed.push(lookup(oe));
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
    if replacements.len() != self.pattern_count as usize {
      return Err(Error::from_reason(format!(
        "Expected {} replacements, got {}",
        self.pattern_count,
        replacements.len()
      )));
    }

    let prep = self.search.prepare(&haystack);
    let search_text = prep.search_text();

    if !self.whole_words {
      // Build result by finding matches on prepared
      // text and replacing spans in the original.
      let mut result =
        String::with_capacity(haystack.len());
      let mut last = 0usize;
      for m in self.search.find_iter(&prep) {
        let os = prep.orig_pos(m.start());
        let oe = prep.orig_pos(m.end());
        result.push_str(&haystack[last..os]);
        result.push_str(
          &replacements[m.pattern().as_usize()],
        );
        last = oe;
      }
      result.push_str(&haystack[last..]);
      return Ok(result);
    }

    let mut result =
      String::with_capacity(haystack.len());
    // `pos` tracks position in search_text.
    // `last_orig` tracks position in original haystack.
    let mut pos: usize = 0;
    let mut last_orig: usize = 0;
    let len = search_text.len();

    while pos < len {
      let Some(m) =
        self.search.find_at(&prep, pos..len)
      else {
        break;
      };

      let os = prep.orig_pos(m.start());
      let oe = prep.orig_pos(m.end());

      if is_whole_word(&haystack, os, oe) {
        result.push_str(&haystack[last_orig..os]);
        result.push_str(
          &replacements[m.pattern().as_usize()],
        );
        pos = m.end();
        last_orig = oe;
      } else if let Some((pat, _, end)) = self
        .search
        .find_whole_word_at(
          &prep,
          m.start(),
          &haystack,
          |p| prep.orig_pos(p),
        )
      {
        let foe = prep.orig_pos(end);
        result.push_str(&haystack[last_orig..os]);
        result.push_str(&replacements[pat as usize]);
        pos = end;
        last_orig = foe;
      } else {
        // No whole-word match here; advance one
        // char in both spaces.
        let orig_start = os;
        let ch_len = haystack[orig_start..]
          .chars()
          .next()
          .map_or(1, |c| c.len_utf8());
        result.push_str(
          &haystack[last_orig..orig_start + ch_len],
        );
        let folded_ch_len = search_text[m.start()..]
          .chars()
          .next()
          .map_or(1, |c| c.len_utf8());
        pos = m.start() + folded_ch_len;
        last_orig = orig_start + ch_len;
      }
    }
    // Copy remaining original text.
    result.push_str(&haystack[last_orig..]);
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
    let prep = self.search.prepare_bytes(bytes);
    self
      .search
      .find_iter_bytes(&prep)
      .map(|m| Match {
        pattern: m.pattern().as_u32(),
        start: prep.orig_pos(m.start()) as u32,
        end: prep.orig_pos(m.end()) as u32,
      })
      .collect()
  }

  /// Zero-copy packed search on a `Buffer`.
  /// Returns `Uint32Array` of `[pattern, start, end]`
  /// triples with **byte offsets**.
  #[napi(js_name = "_findIterPackedBuf")]
  pub fn find_iter_packed_buf(
    &self,
    haystack: Buffer,
  ) -> Uint32Array {
    let bytes: &[u8] = haystack.as_ref();
    let prep = self.search.prepare_bytes(bytes);
    let mut packed = Vec::new();
    for m in self.search.find_iter_bytes(&prep) {
      packed.push(m.pattern().as_u32());
      packed.push(prep.orig_pos(m.start()) as u32);
      packed.push(prep.orig_pos(m.end()) as u32);
    }
    Uint32Array::new(packed)
  }

  /// Check whether any pattern matches in a `Buffer`.
  #[napi]
  pub fn is_match_buf(&self, haystack: Buffer) -> bool {
    let bytes: &[u8] = haystack.as_ref();
    let prep = self.search.prepare_bytes(bytes);
    self.search.is_match_bytes_prep(&prep)
  }

  /// Find matches in a single chunk. Byte offsets
  /// are relative to the chunk start.
  #[napi]
  pub fn find_in_chunk(
    &self,
    chunk: Buffer,
  ) -> Vec<Match> {
    let bytes: &[u8] = chunk.as_ref();
    let prep = self.search.prepare_bytes(bytes);
    self
      .search
      .find_iter_bytes(&prep)
      .map(|m| Match {
        pattern: m.pattern().as_u32(),
        start: prep.orig_pos(m.start()) as u32,
        end: prep.orig_pos(m.end()) as u32,
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
impl StreamMatcher {
  /// Create a streaming matcher.
  #[napi(constructor)]
  pub fn new(
    patterns: Vec<String>,
    options: Option<Options>,
  ) -> Result<Self> {
    panic::catch_unwind(|| {
      Self::new_inner(patterns, options)
    })
    .unwrap_or_else(|e| Err(panic_to_napi_error(e)))
  }

  fn new_inner(
    patterns: Vec<String>,
    options: Option<Options>,
  ) -> Result<Self> {
    let opts = options.unwrap_or_else(default_options);
    let match_kind = resolve_match_kind(
      opts.match_kind.unwrap_or(MatchKind::LeftmostFirst),
    );
    let case_insensitive =
      opts.case_insensitive.unwrap_or(false);
    let dfa = opts.dfa.unwrap_or(false);

    let max_pattern_len = patterns
      .iter()
      .map(|p| p.len())
      .max()
      .unwrap_or(0);

    let search = CaseFoldingAC::build(
      &patterns,
      match_kind,
      case_insensitive,
      dfa,
    )?;

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
      let prep =
        self.search.prepare_bytes(chunk_bytes);
      let matches = self
        .search
        .find_iter_bytes(&prep)
        .map(|m| Match {
          pattern: m.pattern().as_u32(),
          start: (self.global_offset
            + prep.orig_pos(m.start()))
            as u32,
          end: (self.global_offset
            + prep.orig_pos(m.end()))
            as u32,
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
        start: (search_offset + os) as u32,
        end: (search_offset + oe) as u32,
      });
    }

    // Align overlap cut to UTF-8 char boundary
    let overlap_size = (self.max_pattern_len - 1)
      .min(combined.len());
    let mut cut = combined.len() - overlap_size;
    while cut < combined.len()
      && (combined[cut] & 0xC0) == 0x80
    {
      cut += 1; // skip continuation bytes
    }
    self.overlap_buf = combined[cut..].to_vec();
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
