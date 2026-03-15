use std::sync::OnceLock;

use aho_corasick::{
  AhoCorasick as RawAhoCorasick, AhoCorasickBuilder,
  AhoCorasickKind, MatchKind as RawMatchKind,
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

/// Find non-overlapping matches with incremental
/// byte→UTF-16 offset translation. Matches from
/// aho-corasick arrive in ascending byte order, so
/// we maintain a running position and only walk the
/// bytes between consecutive matches.
fn find_with_offsets(
  ac: &RawAhoCorasick,
  haystack: &str,
) -> Vec<Match> {
  let bytes = haystack.as_bytes();
  let mut results = Vec::new();
  let mut last_byte: usize = 0;
  let mut last_utf16: u32 = 0;

  for m in ac.find_iter(haystack) {
    // Advance from last_byte to m.start().
    last_utf16 +=
      byte_span_utf16_len(&bytes[last_byte..m.start()]);
    let start = last_utf16;
    last_byte = m.start();

    // Advance through the match.
    last_utf16 +=
      byte_span_utf16_len(&bytes[last_byte..m.end()]);
    let end = last_utf16;
    last_byte = m.end();

    results.push(Match {
      pattern: m.pattern().as_u32(),
      start,
      end,
    });
  }
  results
}

/// Overlapping search with incremental offset
/// translation. Overlapping matches may NOT arrive
/// in strictly ascending start order (a match can
/// start before a previous one ends), but they do
/// arrive in ascending *end* order. We use a full
/// scan for overlapping since the incremental
/// assumption doesn't hold.
fn find_overlapping_with_offsets(
  ac: &RawAhoCorasick,
  haystack: &str,
) -> Vec<Match> {
  // For overlapping, matches can interleave, so we
  // build a byte→UTF-16 map. But we use the compact
  // OXC-style formula: only iterate char_indices
  // once instead of allocating a full table.
  //
  // Collect all byte positions we need to translate,
  // sort them, then walk once.
  let raw_matches: Vec<_> =
    ac.find_overlapping_iter(haystack).collect();

  if raw_matches.is_empty() {
    return Vec::new();
  }

  // Collect unique byte offsets we need.
  let mut offsets: Vec<usize> = Vec::with_capacity(
    raw_matches.len() * 2,
  );
  for m in &raw_matches {
    offsets.push(m.start());
    offsets.push(m.end());
  }
  offsets.sort_unstable();
  offsets.dedup();

  // Single pass: walk char_indices, resolve each
  // offset as we reach it.
  let mut offset_map: Vec<(usize, u32)> =
    Vec::with_capacity(offsets.len());
  let mut utf16_idx: u32 = 0;
  let mut next = 0;
  let haystack_bytes = haystack.as_bytes();

  for (byte_idx, ch) in haystack.char_indices() {
    while next < offsets.len()
      && offsets[next] == byte_idx
    {
      offset_map.push((byte_idx, utf16_idx));
      next += 1;
    }
    utf16_idx += ch.len_utf16() as u32;
  }
  // Handle offsets at haystack.len().
  let end_byte = haystack_bytes.len();
  while next < offsets.len()
    && offsets[next] == end_byte
  {
    offset_map.push((end_byte, utf16_idx));
    next += 1;
  }

  // Build a lookup closure.
  let lookup = |byte_off: usize| -> u32 {
    match offset_map
      .binary_search_by_key(&byte_off, |&(b, _)| b)
    {
      Ok(i) => offset_map[i].1,
      Err(_) => 0, // should never happen
    }
  };

  raw_matches
    .iter()
    .map(|m| Match {
      pattern: m.pattern().as_u32(),
      start: lookup(m.start()),
      end: lookup(m.end()),
    })
    .collect()
}

// ─── Automaton builders ───────────────────────

fn default_options() -> Options {
  Options {
    match_kind: None,
    case_insensitive: None,
    dfa: None,
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
    let pattern_count = patterns.len() as u32;

    let inner = build_automaton(
      &patterns,
      match_kind,
      case_insensitive,
      dfa,
    )?;

    Ok(Self {
      inner,
      overlapping: OnceLock::new(),
      patterns,
      case_insensitive,
      dfa,
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
    self.inner.is_match(&haystack)
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
    if haystack.is_ascii() {
      let mut packed = Vec::new();
      for m in self.inner.find_iter(&haystack) {
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

    for m in self.inner.find_iter(&haystack) {
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

  /// Find all overlapping matches (packed).
  #[napi(js_name = "_findOverlappingIterPacked")]
  pub fn find_overlapping_iter_packed(
    &self,
    haystack: String,
  ) -> Uint32Array {
    let ov = self.overlapping_ac();

    if haystack.is_ascii() {
      let mut packed = Vec::new();
      for m in ov.find_overlapping_iter(&haystack) {
        packed.push(m.pattern().as_u32());
        packed.push(m.start() as u32);
        packed.push(m.end() as u32);
      }
      return Uint32Array::new(packed);
    }

    let matches =
      find_overlapping_with_offsets(ov, &haystack);
    let mut packed =
      Vec::with_capacity(matches.len() * 3);
    for m in matches {
      packed.push(m.pattern);
      packed.push(m.start);
      packed.push(m.end);
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
    let refs: Vec<&str> =
      replacements.iter().map(|s| s.as_str()).collect();
    Ok(self.inner.replace_all(&haystack, &refs))
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
