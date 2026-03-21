use std::sync::OnceLock;

use aho_corasick::{
  AhoCorasick as RawAhoCorasick, AhoCorasickBuilder,
  AhoCorasickKind, Input, MatchKind as RawMatchKind,
};

// ─── Unicode Simple Case Folding ─────────────
//
// Uses Unicode Simple Case Folding (CaseFolding.txt
// type S/C) instead of `to_lowercase()`. Simple
// folding maps each char to exactly ONE char (never
// changes string length), so byte offsets between
// folded and original text stay in sync.
//
// Key differences from to_lowercase():
//   İ (U+0130) -> i (U+0069), NOT i̇
//   ẞ (U+1E9E) -> ß (U+00DF), NOT ss
//
// Three tiers for performance:
// 1. ASCII: to_ascii_lowercase (no allocation check)
// 2. Non-ASCII, same byte length (99.9%+ of cases):
//    per-char simple fold, PosMapping::Identity
// 3. Byte-length change (İ: 2 bytes -> 1 byte):
//    per-byte offset mapping via PosMapping::Mapped

/// Unicode Simple Case Fold (CaseFolding.txt S/C)
/// plus Turkic İ->i. Always returns exactly one
/// character -- never expands to multiple.
///
/// Uses `unicode-case-mapping` (Unicode 16.0) for
/// the 1,515 standard S/C mappings. İ (U+0130) is
/// added as a special case: Unicode classifies it
/// as status T (Turkic-only) and F (full: İ->i̇),
/// but NOT S/C. We fold İ->i unconditionally because
/// legal documents span jurisdictions and treating
/// İ as case-equivalent to i prevents misses.
#[inline]
fn simple_case_fold(ch: char) -> char {
  match ch {
    '\u{0130}' => 'i', // İ -> i (Turkic, not in S/C)
    _ => unicode_case_mapping::case_folded(ch)
      .and_then(|n| char::from_u32(n.get()))
      .unwrap_or(ch),
  }
}

/// Apply simple case fold to an entire string.
/// Maps each character to exactly one character
/// (never expands), but may change UTF-8 byte
/// length (e.g., İ: 2 bytes -> i: 1 byte).
/// Use `SearchCtx` to handle byte-offset mapping.
fn simple_fold_string(s: &str) -> String {
  s.chars().map(simple_case_fold).collect()
}

/// Folded search text with optional byte offset
/// mapping for the rare case where simple case
/// fold changes UTF-8 byte length (İ 2->1 byte).
pub(crate) enum PosMapping {
  /// Byte positions identical (common case).
  Identity,
  /// folded_byte_pos -> original_byte_pos.
  Mapped(Vec<usize>),
}

struct SearchCtx {
  folded: String,
  mapping: PosMapping,
}

impl SearchCtx {
  fn new(haystack: &str) -> Self {
    if haystack.is_ascii() {
      return Self {
        folded: haystack.to_ascii_lowercase(),
        mapping: PosMapping::Identity,
      };
    }

    let folded = simple_fold_string(haystack);
    if folded.len() == haystack.len() {
      // Same byte length: positions are 1:1.
      // This covers 99.9%+ of non-ASCII text
      // (Czech, German, Polish, Hungarian, etc.)
      return Self {
        folded,
        mapping: PosMapping::Identity,
      };
    }

    // Rare: byte length changed (e.g., İ 2->1).
    // Build per-byte mapping.
    Self::build_mapped(haystack)
  }

  fn build_mapped(original: &str) -> Self {
    let mut folded =
      String::with_capacity(original.len());
    let mut mapping: Vec<usize> =
      Vec::with_capacity(original.len() + 1);

    for (orig_pos, ch) in original.char_indices() {
      let folded_ch = simple_case_fold(ch);
      let before = folded.len();
      folded.push(folded_ch);
      for _ in before..folded.len() {
        mapping.push(orig_pos);
      }
    }
    mapping.push(original.len());

    Self {
      folded,
      mapping: PosMapping::Mapped(mapping),
    }
  }
}

// ─── PreparedSearch ──────────────────────────

/// Prepared search text. For CS or ASCII-CI,
/// this is Direct (zero alloc, zero overhead).
/// For non-ASCII CI, this is Folded (alloc + remap).
pub enum PreparedSearch<'a> {
  Direct(&'a str),
  Folded { text: String, mapping: PosMapping },
}

impl<'a> PreparedSearch<'a> {
  #[inline(always)]
  pub fn search_text(&self) -> &str {
    match self {
      Self::Direct(s) => s,
      Self::Folded { text, .. } => text,
    }
  }

  #[inline(always)]
  pub fn orig_pos(&self, folded_pos: usize) -> usize {
    match self {
      Self::Direct(_) => folded_pos,
      Self::Folded { mapping, .. } => match mapping {
        PosMapping::Identity => folded_pos,
        PosMapping::Mapped(m) => m[folded_pos],
      },
    }
  }
}

/// Same as PreparedSearch but for raw bytes.
pub enum PreparedBytes<'a> {
  Direct(&'a [u8]),
  Folded { bytes: Vec<u8>, mapping: PosMapping },
}

impl<'a> PreparedBytes<'a> {
  #[inline(always)]
  pub fn search_bytes(&self) -> &[u8] {
    match self {
      Self::Direct(b) => b,
      Self::Folded { bytes, .. } => bytes,
    }
  }

  #[inline(always)]
  pub fn orig_pos(&self, folded_pos: usize) -> usize {
    match self {
      Self::Direct(_) => folded_pos,
      Self::Folded { mapping, .. } => match mapping {
        PosMapping::Identity => folded_pos,
        PosMapping::Mapped(m) => m[folded_pos],
      },
    }
  }
}

// ─── CaseFoldingAC ───────────────────────────

/// Encapsulates a raw Aho-Corasick automaton with
/// case-folding logic. The `raw` field is private
/// to this module; all search must go through
/// CaseFoldingAC methods.
pub struct CaseFoldingAC {
  raw: RawAhoCorasick,
  overlapping: OnceLock<RawAhoCorasick>,
  patterns: Vec<String>,
  case_insensitive: bool,
  dfa: bool,
  max_pattern_byte_len: usize,
}

impl CaseFoldingAC {
  pub fn build(
    patterns: &[String],
    match_kind: RawMatchKind,
    case_insensitive: bool,
    dfa: bool,
  ) -> Result<Self, napi::Error> {
    let effective_patterns: Vec<String> =
      if case_insensitive {
        patterns
          .iter()
          .map(|p| simple_fold_string(p))
          .collect()
      } else {
        patterns.to_vec()
      };
    let mut builder = AhoCorasickBuilder::new();
    builder.match_kind(match_kind);
    if case_insensitive {
      // Belt: automaton handles ASCII CI natively
      builder.ascii_case_insensitive(true);
    }
    if dfa {
      builder.kind(Some(AhoCorasickKind::DFA));
    }
    let raw = builder
      .build(&effective_patterns)
      .map_err(|e| {
        napi::Error::from_reason(format!(
          "Failed to build automaton: {e}"
        ))
      })?;
    let max_pattern_byte_len = patterns
      .iter()
      .map(|p| p.len())
      .max()
      .unwrap_or(0);
    Ok(Self {
      raw,
      overlapping: OnceLock::new(),
      patterns: patterns.to_vec(),
      case_insensitive,
      dfa,
      max_pattern_byte_len,
    })
  }

  /// Zero-alloc for CS or ASCII-CI.
  #[inline(always)]
  pub fn prepare<'a>(
    &self,
    text: &'a str,
  ) -> PreparedSearch<'a> {
    if !self.case_insensitive || text.is_ascii() {
      PreparedSearch::Direct(text)
    } else {
      let ctx = SearchCtx::new(text);
      PreparedSearch::Folded {
        text: ctx.folded,
        mapping: ctx.mapping,
      }
    }
  }

  /// Zero-alloc for CS, ASCII-CI, or non-UTF-8.
  #[inline(always)]
  pub fn prepare_bytes<'a>(
    &self,
    bytes: &'a [u8],
  ) -> PreparedBytes<'a> {
    if !self.case_insensitive || bytes.is_ascii() {
      // CS: no folding. ASCII CI: automaton handles
      // it via ascii_case_insensitive. Single scan.
      return PreparedBytes::Direct(bytes);
    }
    // Non-ASCII CI: need UTF-8 validation + fold.
    match std::str::from_utf8(bytes) {
      Ok(text) => {
        let ctx = SearchCtx::new(text);
        PreparedBytes::Folded {
          bytes: ctx.folded.into_bytes(),
          mapping: ctx.mapping,
        }
      }
      // Non-UTF-8: best effort with automaton
      // (ascii_case_insensitive handles ASCII bytes).
      _ => PreparedBytes::Direct(bytes),
    }
  }

  /// Iterate matches on prepared text.
  pub fn find_iter<'a, 'h>(
    &'a self,
    prep: &'h PreparedSearch<'h>,
  ) -> aho_corasick::FindIter<'a, 'h> {
    self.raw.find_iter(prep.search_text())
  }

  /// Iterate matches on prepared bytes.
  pub fn find_iter_bytes<'a, 'h>(
    &'a self,
    prep: &'h PreparedBytes<'h>,
  ) -> aho_corasick::FindIter<'a, 'h> {
    self.raw.find_iter(prep.search_bytes())
  }

  /// Find next match from position (for wholeWords
  /// incremental search).
  pub fn find_at(
    &self,
    prep: &PreparedSearch,
    range: std::ops::Range<usize>,
  ) -> Option<aho_corasick::Match> {
    self
      .raw
      .find(Input::new(prep.search_text()).range(range))
  }

  /// Check if any match exists.
  pub fn is_match_str(
    &self,
    prep: &PreparedSearch,
  ) -> bool {
    self.raw.is_match(prep.search_text())
  }

  pub fn is_match_bytes_prep(
    &self,
    prep: &PreparedBytes,
  ) -> bool {
    self.raw.is_match(prep.search_bytes())
  }

  /// Overlapping search for wholeWords: find the
  /// longest whole-word match starting at `start`.
  pub fn find_whole_word_at(
    &self,
    prep: &PreparedSearch,
    start: usize,
    haystack: &str,
    orig_pos_fn: impl Fn(usize) -> usize,
  ) -> Option<(u32, usize, usize)> {
    let ov = self.overlapping_ac();
    let input =
      Input::new(prep.search_text()).range(start..);

    let mut best: Option<(u32, usize, usize)> = None;
    let mut state = aho_corasick::automaton::OverlappingState::start();

    loop {
      ov.find_overlapping(input.clone(), &mut state);
      let Some(m) = state.get_match() else {
        break;
      };

      if m.end()
        > start + self.max_pattern_byte_len
      {
        break;
      }

      if m.start() != start {
        continue;
      }

      let os = orig_pos_fn(m.start());
      let oe = orig_pos_fn(m.end());
      if crate::is_whole_word(haystack, os, oe) {
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

  /// Overlapping search stepping (for
  /// find_overlapping_iter_packed).
  pub fn overlapping_find_iter<'a, 'h>(
    &'a self,
    prep: &'h PreparedSearch<'h>,
  ) -> aho_corasick::FindOverlappingIter<'a, 'h> {
    self
      .overlapping_ac()
      .find_overlapping_iter(prep.search_text())
  }

  fn overlapping_ac(&self) -> &RawAhoCorasick {
    self.overlapping.get_or_init(|| {
      let effective = if self.case_insensitive {
        self
          .patterns
          .iter()
          .map(|p| simple_fold_string(p))
          .collect::<Vec<_>>()
      } else {
        self.patterns.clone()
      };
      let mut builder = AhoCorasickBuilder::new();
      builder.match_kind(RawMatchKind::Standard);
      if self.case_insensitive {
        builder.ascii_case_insensitive(true);
      }
      if self.dfa {
        builder.kind(Some(AhoCorasickKind::DFA));
      }
      builder
        .build(&effective)
        .expect("overlapping build failed")
    })
  }
}
