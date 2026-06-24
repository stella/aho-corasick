#![allow(clippy::redundant_pub_crate)]

use std::sync::OnceLock;

use aho_corasick::{
  AhoCorasick as RawAhoCorasick, AhoCorasickBuilder, AhoCorasickKind,
  MatchKind as RawMatchKind,
};

use crate::Error;

const ASCII_CI_BUILDER_PATTERN_LIMIT: usize = 4096;

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
  if ch.is_ascii() {
    return ch.to_ascii_lowercase();
  }

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

fn effective_patterns(
  mut patterns: Vec<String>,
  case_insensitive: bool,
  ascii_case_insensitive: bool,
) -> Vec<String> {
  if !case_insensitive {
    return patterns;
  }

  for pattern in &mut patterns {
    if pattern.is_ascii() {
      if !ascii_case_insensitive {
        pattern.make_ascii_lowercase();
      }
      continue;
    }
    *pattern = simple_fold_string(pattern);
  }

  patterns
}

/// Folded search text with optional byte offset
/// mapping for the rare case where simple case
/// fold changes UTF-8 byte length (İ 2->1 byte).
pub(crate) enum PosMapping {
  /// Byte positions identical (common case).
  Identity,
  /// `folded_byte_pos` -> `original_byte_pos`.
  Mapped(Vec<usize>),
}

fn mapped_pos(mapping: &[usize], folded_pos: usize) -> usize {
  mapping
    .get(folded_pos)
    .copied()
    .unwrap_or_else(|| mapping.last().copied().unwrap_or(folded_pos))
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
    let mut folded = String::with_capacity(original.len());
    let mut mapping: Vec<usize> =
      Vec::with_capacity(original.len().saturating_add(1));

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
pub(crate) enum PreparedSearch<'a> {
  Direct(&'a str),
  Folded { text: String, mapping: PosMapping },
}

impl PreparedSearch<'_> {
  #[inline]
  pub(crate) fn search_text(&self) -> &str {
    match self {
      Self::Direct(s) => s,
      Self::Folded { text, .. } => text,
    }
  }

  #[inline]
  pub(crate) fn orig_pos(&self, folded_pos: usize) -> usize {
    match self {
      Self::Direct(_) => folded_pos,
      Self::Folded { mapping, .. } => match mapping {
        PosMapping::Identity => folded_pos,
        PosMapping::Mapped(m) => mapped_pos(m, folded_pos),
      },
    }
  }
}

/// Same as `PreparedSearch` but for raw bytes.
pub(crate) enum PreparedBytes<'a> {
  Direct(&'a [u8]),
  Folded { bytes: Vec<u8>, mapping: PosMapping },
}

impl PreparedBytes<'_> {
  #[inline]
  pub(crate) fn search_bytes(&self) -> &[u8] {
    match self {
      Self::Direct(b) => b,
      Self::Folded { bytes, .. } => bytes,
    }
  }

  #[inline]
  pub(crate) fn orig_pos(&self, folded_pos: usize) -> usize {
    match self {
      Self::Direct(_) => folded_pos,
      Self::Folded { mapping, .. } => match mapping {
        PosMapping::Identity => folded_pos,
        PosMapping::Mapped(m) => mapped_pos(m, folded_pos),
      },
    }
  }
}

// ─── CaseFoldingAC ───────────────────────────

/// Encapsulates a raw Aho-Corasick automaton with
/// case-folding logic. The `raw` field is private
/// to this module; all search must go through
/// `CaseFoldingAC` methods.
pub(crate) struct CaseFoldingAC {
  raw: RawAhoCorasick,
  overlap: OverlapAutomaton,
  case_insensitive: bool,
  ascii_case_insensitive: bool,
}

enum OverlapAutomaton {
  Native,
  Fallback {
    automaton: OnceLock<Result<RawAhoCorasick, String>>,
    patterns: Vec<String>,
    ascii_case_insensitive: bool,
    dfa: bool,
  },
}

impl CaseFoldingAC {
  pub(crate) fn build(
    patterns: Vec<String>,
    match_kind: RawMatchKind,
    case_insensitive: bool,
    dfa: bool,
  ) -> Result<Self, Error> {
    let ascii_case_insensitive =
      case_insensitive && patterns.len() <= ASCII_CI_BUILDER_PATTERN_LIMIT;
    let effective_patterns =
      effective_patterns(patterns, case_insensitive, ascii_case_insensitive);
    let mut builder = AhoCorasickBuilder::new();
    builder.match_kind(match_kind);
    if ascii_case_insensitive {
      builder.ascii_case_insensitive(true);
    }
    if dfa {
      builder.kind(Some(AhoCorasickKind::DFA));
    }
    let raw = builder
      .build(&effective_patterns)
      .map_err(|e| Error::BuildAutomaton(e.to_string()))?;
    let overlap = if matches!(match_kind, RawMatchKind::Standard) {
      OverlapAutomaton::Native
    } else {
      OverlapAutomaton::Fallback {
        automaton: OnceLock::new(),
        patterns: effective_patterns,
        ascii_case_insensitive,
        dfa,
      }
    };

    Ok(Self {
      raw,
      overlap,
      case_insensitive,
      ascii_case_insensitive,
    })
  }

  /// Zero-alloc for CS or ASCII-CI.
  #[inline]
  pub(crate) fn prepare<'a>(&self, text: &'a str) -> PreparedSearch<'a> {
    if !self.case_insensitive
      || (self.ascii_case_insensitive && text.is_ascii())
    {
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
  #[inline]
  pub(crate) fn prepare_bytes<'a>(&self, bytes: &'a [u8]) -> PreparedBytes<'a> {
    if !self.case_insensitive
      || (self.ascii_case_insensitive && bytes.is_ascii())
    {
      return PreparedBytes::Direct(bytes);
    }

    std::str::from_utf8(bytes).map_or_else(
      |_| PreparedBytes::Folded {
        bytes: bytes.iter().map(u8::to_ascii_lowercase).collect(),
        mapping: PosMapping::Identity,
      },
      |text| {
        let ctx = SearchCtx::new(text);
        PreparedBytes::Folded {
          bytes: ctx.folded.into_bytes(),
          mapping: ctx.mapping,
        }
      },
    )
  }

  /// Iterate matches on prepared text.
  pub(crate) fn find_iter<'a, 'h>(
    &'a self,
    prep: &'h PreparedSearch<'h>,
  ) -> aho_corasick::FindIter<'a, 'h> {
    self.raw.find_iter(prep.search_text())
  }

  /// Iterate matches on prepared bytes.
  pub(crate) fn find_iter_bytes<'a, 'h>(
    &'a self,
    prep: &'h PreparedBytes<'h>,
  ) -> aho_corasick::FindIter<'a, 'h> {
    self.raw.find_iter(prep.search_bytes())
  }

  /// Check if any match exists.
  pub(crate) fn is_match_str(&self, prep: &PreparedSearch<'_>) -> bool {
    self.raw.is_match(prep.search_text())
  }

  pub(crate) fn is_match_bytes_prep(&self, prep: &PreparedBytes<'_>) -> bool {
    self.raw.is_match(prep.search_bytes())
  }

  /// Overlapping search stepping (for
  /// `find_overlapping_iter_packed`).
  pub(crate) fn overlapping_find_iter<'a, 'h>(
    &'a self,
    prep: &'h PreparedSearch<'h>,
  ) -> Result<aho_corasick::FindOverlappingIter<'a, 'h>, Error> {
    Ok(
      self
        .overlapping_ac()?
        .find_overlapping_iter(prep.search_text()),
    )
  }

  fn overlapping_ac(&self) -> Result<&RawAhoCorasick, Error> {
    match &self.overlap {
      OverlapAutomaton::Native => Ok(&self.raw),
      OverlapAutomaton::Fallback {
        automaton,
        patterns,
        ascii_case_insensitive,
        dfa,
      } => automaton
        .get_or_init(|| {
          let mut builder = AhoCorasickBuilder::new();
          builder.match_kind(RawMatchKind::Standard);
          if *ascii_case_insensitive {
            builder.ascii_case_insensitive(true);
          }
          if *dfa {
            builder.kind(Some(AhoCorasickKind::DFA));
          }
          builder.build(patterns).map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(|reason| Error::BuildOverlappingAutomaton(reason.clone())),
    }
  }
}
