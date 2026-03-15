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

/// Build a byte-offset → UTF-16-code-unit-offset
/// lookup table.
///
/// JS strings are UTF-16: chars above U+FFFF
/// (emoji, CJK extensions, etc.) take 2 code units
/// (a surrogate pair). We must return offsets
/// compatible with `String.prototype.slice()`.
fn build_byte_to_utf16_table(
  haystack: &str,
) -> Vec<u32> {
  let mut table = vec![0u32; haystack.len() + 1];
  let mut utf16_idx: u32 = 0;
  for (byte_idx, ch) in haystack.char_indices() {
    table[byte_idx] = utf16_idx;
    utf16_idx += ch.len_utf16() as u32;
  }
  table[haystack.len()] = utf16_idx;
  table
}


fn default_options() -> Options {
  Options {
    match_kind: None,
    case_insensitive: None,
    dfa: None,
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

/// Aho-Corasick automaton for multi-pattern string
/// searching.
#[napi]
pub struct AhoCorasick {
  /// Main automaton (leftmost semantics).
  inner: RawAhoCorasick,
  /// Separate automaton for overlapping search
  /// (Standard match kind required by the crate).
  overlapping: RawAhoCorasick,
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
    let opts = options.unwrap_or_else(default_options);

    let match_kind = opts
      .match_kind
      .unwrap_or(MatchKind::LeftmostFirst);
    let case_insensitive =
      opts.case_insensitive.unwrap_or(false);
    let dfa = opts.dfa.unwrap_or(false);

    let raw_match_kind = match match_kind {
      MatchKind::LeftmostFirst => {
        RawMatchKind::LeftmostFirst
      }
      MatchKind::LeftmostLongest => {
        RawMatchKind::LeftmostLongest
      }
    };

    let pattern_count = patterns.len() as u32;

    let inner = build_automaton(
      &patterns,
      raw_match_kind,
      case_insensitive,
      dfa,
    )?;

    // Overlapping requires MatchKind::Standard.
    let overlapping = build_automaton(
      &patterns,
      RawMatchKind::Standard,
      case_insensitive,
      dfa,
    )?;

    Ok(Self {
      inner,
      overlapping,
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
  pub fn is_match(
    &self,
    haystack: String,
  ) -> bool {
    self.inner.is_match(&haystack)
  }

  /// Find all non-overlapping matches.
  #[napi]
  pub fn find_iter(
    &self,
    haystack: String,
  ) -> Vec<Match> {
    // ASCII fast path: byte offsets == char offsets.
    if haystack.is_ascii() {
      return self
        .inner
        .find_iter(&haystack)
        .map(|m| Match {
          pattern: m.pattern().as_u32(),
          start: m.start() as u32,
          end: m.end() as u32,
        })
        .collect();
    }

    let table = build_byte_to_utf16_table(&haystack);
    self
      .inner
      .find_iter(&haystack)
      .map(|m| Match {
        pattern: m.pattern().as_u32(),
        start: table[m.start()],
        end: table[m.end()],
      })
      .collect()
  }

  /// Find all overlapping matches.
  ///
  /// Reports every match at every position, including
  /// those that overlap with each other.
  #[napi]
  pub fn find_overlapping_iter(
    &self,
    haystack: String,
  ) -> Vec<Match> {
    if haystack.is_ascii() {
      return self
        .overlapping
        .find_overlapping_iter(&haystack)
        .map(|m| Match {
          pattern: m.pattern().as_u32(),
          start: m.start() as u32,
          end: m.end() as u32,
        })
        .collect();
    }

    let table = build_byte_to_utf16_table(&haystack);
    self
      .overlapping
      .find_overlapping_iter(&haystack)
      .map(|m| Match {
        pattern: m.pattern().as_u32(),
        start: table[m.start()],
        end: table[m.end()],
      })
      .collect()
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

  /// Find matches in a single chunk. Byte offsets are
  /// relative to the chunk start.
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

/// Streaming matcher that handles chunk boundaries.
///
/// Feed chunks via `write()` and collect matches.
/// Internally buffers the overlap region between
/// chunks so cross-boundary matches are found.
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
    let opts = options.unwrap_or_else(default_options);

    let match_kind = opts
      .match_kind
      .unwrap_or(MatchKind::LeftmostFirst);
    let case_insensitive =
      opts.case_insensitive.unwrap_or(false);
    let dfa = opts.dfa.unwrap_or(false);

    let raw_match_kind = match match_kind {
      MatchKind::LeftmostFirst => {
        RawMatchKind::LeftmostFirst
      }
      MatchKind::LeftmostLongest => {
        RawMatchKind::LeftmostLongest
      }
    };

    let max_pattern_len = patterns
      .iter()
      .map(|p| p.len())
      .max()
      .unwrap_or(0);

    let inner = build_automaton(
      &patterns,
      raw_match_kind,
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

  /// Feed a chunk and return matches with global byte
  /// offsets.
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
      // Skip matches fully within the overlap
      // (already reported by previous write).
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

    // Save tail as overlap for next chunk.
    let overlap_size = (self.max_pattern_len - 1)
      .min(combined.len());
    self.overlap_buf = combined
      [combined.len() - overlap_size..]
      .to_vec();

    self.global_offset += chunk_bytes.len();
    matches
  }

  /// Flush remaining state. Call after the last chunk.
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
