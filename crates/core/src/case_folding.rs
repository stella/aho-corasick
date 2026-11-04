#![allow(clippy::redundant_pub_crate)]

use std::{collections::HashMap, sync::OnceLock};

use daachorse::{
  DoubleArrayAhoCorasick as RawAhoCorasick, DoubleArrayAhoCorasickBuilder,
  MatchKind as RawMatchKind,
};

use crate::Error;

/// Unicode Simple Case Fold (CaseFolding.txt S/C) plus Turkic İ->i.
#[inline]
fn simple_case_fold(ch: char) -> char {
  if ch.is_ascii() {
    return ch.to_ascii_lowercase();
  }

  match ch {
    '\u{0130}' => 'i',
    _ => unicode_case_mapping::case_folded(ch)
      .and_then(|n| char::from_u32(n.get()))
      .unwrap_or(ch),
  }
}

fn simple_fold_string(s: &str) -> String {
  s.chars().map(simple_case_fold).collect()
}

/// The automaton's patterns, one per distinct effective pattern, plus every
/// later input index whose effective pattern repeats an earlier one.
struct EffectivePatterns {
  values: Vec<(String, u32)>,
  duplicates: PatternDuplicates,
}

/// Input indexes whose effective pattern (after case folding) repeats an
/// earlier one. The automaton holds each distinct pattern once, under its
/// first index; overlapping search reports every index, so each match of a
/// first index also stands for the repeats listed here.
#[derive(Default)]
pub(crate) struct PatternDuplicates {
  /// `(first index, repeating index)`, sorted by both fields.
  pairs: Vec<(u32, u32)>,
}

impl PatternDuplicates {
  pub(crate) fn from_pairs(pairs: Vec<(u32, u32)>) -> Result<Self, Error> {
    let ordered = pairs.is_sorted()
      && pairs.windows(2).all(|pair| pair.first() != pair.last());
    let forward = pairs.iter().all(|(first, repeat)| first < repeat);
    // Each repeat repeats exactly one first index, and a repeat is never
    // itself a first index: the automaton holds first indexes only.
    let mut repeats: Vec<u32> =
      pairs.iter().map(|(_, repeat)| *repeat).collect();
    repeats.sort_unstable();
    let unique = repeats.windows(2).all(|pair| pair.first() != pair.last());
    let firsts_are_not_repeats = pairs
      .iter()
      .all(|(first, _)| repeats.binary_search(first).is_err());
    if !ordered || !forward || !unique || !firsts_are_not_repeats {
      return Err(Error::InvalidPreparedAutomaton(
        "pattern duplicates must be sorted, refer forward, and map each repeat to one first index"
          .to_owned(),
      ));
    }
    Ok(Self { pairs })
  }

  fn pairs(&self) -> &[(u32, u32)] {
    &self.pairs
  }

  fn repeats_of(&self, first: u32) -> impl Iterator<Item = u32> + '_ {
    let from = self.pairs.partition_point(|(index, _)| *index < first);
    self
      .pairs
      .get(from..)
      .unwrap_or_default()
      .iter()
      .take_while(move |(index, _)| *index == first)
      .map(|(_, repeat)| *repeat)
  }
}

fn effective_pattern_values(
  patterns: Vec<String>,
  case_insensitive: bool,
) -> Result<EffectivePatterns, Error> {
  let mut first_index = HashMap::with_capacity(patterns.len());
  let mut values = Vec::with_capacity(patterns.len());
  let mut duplicates = Vec::new();

  for (index, mut pattern) in patterns.into_iter().enumerate() {
    let index =
      u32::try_from(index).map_err(|_| Error::PatternIndexDoesNotFit)?;
    if pattern.is_empty() {
      return Err(Error::empty_pattern(index));
    }
    if case_insensitive {
      if pattern.is_ascii() {
        pattern.make_ascii_lowercase();
      } else {
        pattern = simple_fold_string(&pattern);
      }
    }
    if let Some(first) = first_index.get(&pattern) {
      duplicates.push((*first, index));
    } else {
      first_index.insert(pattern.clone(), index);
      values.push((pattern, index));
    }
  }

  // Indexes arrive in ascending order, so sorting by first index keeps each
  // first index's repeats ascending.
  duplicates.sort_unstable();
  Ok(EffectivePatterns {
    values,
    duplicates: PatternDuplicates { pairs: duplicates },
  })
}

fn build_raw_automaton(
  pattern_values: &[(String, u32)],
  match_kind: RawMatchKind,
) -> Result<Option<RawAhoCorasick<u32>>, String> {
  if pattern_values.is_empty() {
    return Ok(None);
  }

  DoubleArrayAhoCorasickBuilder::new()
    .match_kind(match_kind)
    .build_with_values(
      pattern_values
        .iter()
        .map(|(pattern, index)| (pattern.as_bytes(), *index)),
    )
    .map(Some)
    .map_err(|error| error.to_string())
}

/// Folded search text with optional byte offset mapping for the rare case where
/// simple case fold changes UTF-8 byte length.
pub(crate) enum PosMapping {
  Identity,
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

    let mut folded = String::with_capacity(haystack.len());
    let mut preserves_boundaries = true;
    for ch in haystack.chars() {
      let folded_ch = simple_case_fold(ch);
      preserves_boundaries &= ch.len_utf8() == folded_ch.len_utf8();
      folded.push(folded_ch);
    }
    if preserves_boundaries {
      return Self {
        folded,
        mapping: PosMapping::Identity,
      };
    }

    Self::build_mapped(haystack, folded)
  }

  fn build_mapped(original: &str, folded: String) -> Self {
    let mut mapping = Vec::with_capacity(original.len().saturating_add(1));

    for ((orig_pos, _), folded_ch) in
      original.char_indices().zip(folded.chars())
    {
      mapping.extend(std::iter::repeat_n(orig_pos, folded_ch.len_utf8()));
    }
    mapping.push(original.len());

    Self {
      folded,
      mapping: PosMapping::Mapped(mapping),
    }
  }
}

pub(crate) enum PreparedSearch<'a> {
  Direct(&'a str),
  Folded { text: String, mapping: PosMapping },
}

impl PreparedSearch<'_> {
  #[inline]
  fn search_text(&self) -> &str {
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

pub(crate) enum PreparedBytes<'a> {
  Direct(&'a [u8]),
  Folded { bytes: Vec<u8>, mapping: PosMapping },
}

impl PreparedBytes<'_> {
  #[inline]
  fn search_bytes(&self) -> &[u8] {
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

#[derive(Clone, Copy)]
pub(crate) struct RawPattern(u32);

impl RawPattern {
  pub(crate) const fn as_u32(self) -> u32 {
    self.0
  }
}

#[derive(Clone, Copy)]
pub(crate) struct RawMatch {
  pattern: u32,
  start: usize,
  end: usize,
}

impl RawMatch {
  pub(crate) const fn pattern(self) -> RawPattern {
    RawPattern(self.pattern)
  }

  pub(crate) const fn start(self) -> usize {
    self.start
  }

  pub(crate) const fn end(self) -> usize {
    self.end
  }
}

pub(crate) struct CaseFoldingAC {
  raw: Option<RawAhoCorasick<u32>>,
  match_kind: RawMatchKind,
  overlap: OverlapAutomaton,
  case_insensitive: bool,
  duplicates: PatternDuplicates,
}

enum OverlapAutomaton {
  Native,
  Prepared {
    automaton: Option<RawAhoCorasick<u32>>,
  },
  Fallback {
    automaton: OnceLock<Result<Option<RawAhoCorasick<u32>>, String>>,
    pattern_values: Vec<(String, u32)>,
  },
}

pub(crate) struct PreparedAutomata<'a> {
  pub(crate) main: Vec<u8>,
  pub(crate) overlap: Option<Vec<u8>>,
  pub(crate) duplicates: &'a [(u32, u32)],
}

impl CaseFoldingAC {
  pub(crate) fn build(
    patterns: Vec<String>,
    match_kind: RawMatchKind,
    case_insensitive: bool,
    _dfa: bool,
  ) -> Result<Self, Error> {
    let EffectivePatterns {
      values: pattern_values,
      duplicates,
    } = effective_pattern_values(patterns, case_insensitive)?;
    let raw = build_raw_automaton(&pattern_values, match_kind)
      .map_err(Error::BuildAutomaton)?;
    let overlap = if matches!(match_kind, RawMatchKind::Standard) {
      OverlapAutomaton::Native
    } else {
      OverlapAutomaton::Fallback {
        automaton: OnceLock::new(),
        pattern_values,
      }
    };

    Ok(Self {
      raw,
      match_kind,
      overlap,
      case_insensitive,
      duplicates,
    })
  }

  pub(crate) fn from_prepared(
    match_kind: RawMatchKind,
    case_insensitive: bool,
    main: &[u8],
    overlap: Option<&[u8]>,
    duplicates: PatternDuplicates,
  ) -> Result<Self, Error> {
    let raw = deserialize_raw_automaton(main)?;
    let overlap = if matches!(match_kind, RawMatchKind::Standard) {
      OverlapAutomaton::Native
    } else {
      let Some(overlap) = overlap else {
        return Err(Error::InvalidPreparedAutomaton(
          "missing overlapping automaton".to_owned(),
        ));
      };
      OverlapAutomaton::Prepared {
        automaton: deserialize_raw_automaton(overlap)?,
      }
    };

    Ok(Self {
      raw,
      match_kind,
      overlap,
      case_insensitive,
      duplicates,
    })
  }

  pub(crate) fn prepared_automata(
    &self,
  ) -> Result<PreparedAutomata<'_>, Error> {
    let main = serialize_raw_automaton(self.raw.as_ref());
    let overlap = match &self.overlap {
      OverlapAutomaton::Native => None,
      OverlapAutomaton::Prepared { automaton } => {
        Some(serialize_raw_automaton(automaton.as_ref()))
      }
      OverlapAutomaton::Fallback {
        automaton,
        pattern_values,
      } => {
        let automaton = automaton
          .get_or_init(|| {
            build_raw_automaton(pattern_values, RawMatchKind::Standard)
          })
          .as_ref()
          .map_err(|reason| Error::BuildOverlappingAutomaton(reason.clone()))?;
        Some(serialize_raw_automaton(automaton.as_ref()))
      }
    };

    Ok(PreparedAutomata {
      main,
      overlap,
      duplicates: self.duplicates.pairs(),
    })
  }

  pub(crate) const fn match_kind(&self) -> RawMatchKind {
    self.match_kind
  }

  pub(crate) const fn case_insensitive(&self) -> bool {
    self.case_insensitive
  }

  #[inline]
  pub(crate) fn prepare<'a>(&self, text: &'a str) -> PreparedSearch<'a> {
    if !self.case_insensitive {
      return PreparedSearch::Direct(text);
    }

    let ctx = SearchCtx::new(text);
    PreparedSearch::Folded {
      text: ctx.folded,
      mapping: ctx.mapping,
    }
  }

  #[inline]
  pub(crate) fn prepare_bytes<'a>(&self, bytes: &'a [u8]) -> PreparedBytes<'a> {
    if !self.case_insensitive {
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

  pub(crate) fn find_iter(&self, prep: &PreparedSearch<'_>) -> Vec<RawMatch> {
    // Bytewise empty matches can fall inside a scalar. Filter in search space
    // before offset remapping or any string consumer observes them.
    let text = prep.search_text();
    find_iter_raw(self.raw.as_ref(), self.match_kind, text.as_bytes())
      .into_iter()
      .filter(|m| {
        text.is_char_boundary(m.start()) && text.is_char_boundary(m.end())
      })
      .collect()
  }

  pub(crate) fn find_iter_bytes(
    &self,
    prep: &PreparedBytes<'_>,
  ) -> Vec<RawMatch> {
    find_iter_raw(self.raw.as_ref(), self.match_kind, prep.search_bytes())
  }

  pub(crate) fn is_match_str(&self, prep: &PreparedSearch<'_>) -> bool {
    is_match_raw(
      self.raw.as_ref(),
      self.match_kind,
      prep.search_text().as_bytes(),
    )
  }

  pub(crate) fn is_match_bytes_prep(&self, prep: &PreparedBytes<'_>) -> bool {
    is_match_raw(self.raw.as_ref(), self.match_kind, prep.search_bytes())
  }

  pub(crate) fn overlapping_find_iter(
    &self,
    prep: &PreparedSearch<'_>,
  ) -> Result<Vec<RawMatch>, Error> {
    let automaton = self.overlapping_ac()?;
    let text = prep.search_text();
    let matches = overlapping_iter_raw(automaton, text.as_bytes())
      .into_iter()
      .filter(|m| {
        text.is_char_boundary(m.start()) && text.is_char_boundary(m.end())
      });
    if self.duplicates.pairs().is_empty() {
      return Ok(matches.collect());
    }
    // Overlapping search reports every pattern that matches, so a repeated
    // pattern matches under each of its indexes, in ascending order.
    let mut expanded = Vec::new();
    for m in matches {
      expanded.push(m);
      expanded.extend(
        self
          .duplicates
          .repeats_of(m.pattern)
          .map(|repeat| raw_match(repeat, m.start, m.end)),
      );
    }
    Ok(expanded)
  }

  fn overlapping_ac(&self) -> Result<Option<&RawAhoCorasick<u32>>, Error> {
    match &self.overlap {
      OverlapAutomaton::Native => Ok(self.raw.as_ref()),
      OverlapAutomaton::Prepared { automaton } => Ok(automaton.as_ref()),
      OverlapAutomaton::Fallback {
        automaton,
        pattern_values,
      } => automaton
        .get_or_init(|| {
          build_raw_automaton(pattern_values, RawMatchKind::Standard)
        })
        .as_ref()
        .map(Option::as_ref)
        .map_err(|reason| Error::BuildOverlappingAutomaton(reason.clone())),
    }
  }
}

fn serialize_raw_automaton(raw: Option<&RawAhoCorasick<u32>>) -> Vec<u8> {
  raw.map_or_else(Vec::new, RawAhoCorasick::serialize)
}

fn deserialize_raw_automaton(
  bytes: &[u8],
) -> Result<Option<RawAhoCorasick<u32>>, Error> {
  if bytes.is_empty() {
    return Ok(None);
  }

  let (raw, rest) = RawAhoCorasick::<u32>::deserialize(bytes)
    .map_err(|error| Error::InvalidPreparedAutomaton(error.to_string()))?;
  if !rest.is_empty() {
    return Err(Error::InvalidPreparedAutomaton(
      "trailing automaton bytes".to_owned(),
    ));
  }
  if let Some(m) = find_iter_raw(Some(&raw), raw.match_kind(), b"").first() {
    return Err(Error::empty_pattern(m.pattern));
  }
  Ok(Some(raw))
}

const fn raw_match(pattern: u32, start: usize, end: usize) -> RawMatch {
  RawMatch {
    pattern,
    start,
    end,
  }
}

fn find_iter_raw(
  raw: Option<&RawAhoCorasick<u32>>,
  match_kind: RawMatchKind,
  haystack: &[u8],
) -> Vec<RawMatch> {
  let Some(raw) = raw else {
    return Vec::new();
  };

  if matches!(match_kind, RawMatchKind::Standard) {
    return raw
      .find_iter(haystack)
      .map(|m| raw_match(m.value(), m.start(), m.end()))
      .collect();
  }

  raw
    .leftmost_find_iter(haystack)
    .map(|m| raw_match(m.value(), m.start(), m.end()))
    .collect()
}

fn overlapping_iter_raw(
  raw: Option<&RawAhoCorasick<u32>>,
  haystack: &[u8],
) -> Vec<RawMatch> {
  let Some(raw) = raw else {
    return Vec::new();
  };

  raw
    .find_overlapping_iter(haystack)
    .map(|m| raw_match(m.value(), m.start(), m.end()))
    .collect()
}

fn is_match_raw(
  raw: Option<&RawAhoCorasick<u32>>,
  match_kind: RawMatchKind,
  haystack: &[u8],
) -> bool {
  let Some(raw) = raw else {
    return false;
  };

  if matches!(match_kind, RawMatchKind::Standard) {
    return raw.find_iter(haystack).next().is_some();
  }

  raw.leftmost_find_iter(haystack).next().is_some()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::missing_assert_message)]
mod tests {
  use super::{
    CaseFoldingAC, DoubleArrayAhoCorasickBuilder, PatternDuplicates,
    PosMapping, RawMatchKind, SearchCtx,
  };
  use crate::Error;

  #[test]
  fn equal_scalar_width_folds_keep_identity_mapping() {
    let ctx = SearchCtx::new("ÉΩ😀A");
    assert_eq!(ctx.folded, "éω😀a");
    assert!(matches!(ctx.mapping, PosMapping::Identity));
  }

  #[test]
  fn cancelling_scalar_width_changes_still_map_offsets() {
    let original = "ȺȺ\u{212A}";
    let ctx = SearchCtx::new(original);
    assert_eq!(ctx.folded, "ⱥⱥk");
    assert_eq!(ctx.folded.len(), original.len());
    let mapping = match ctx.mapping {
      PosMapping::Mapped(mapping) => Some(mapping),
      PosMapping::Identity => None,
    };
    assert_eq!(mapping, Some(vec![0, 0, 0, 2, 2, 2, 4, 7]));
  }

  #[test]
  fn prepared_automata_reject_empty_patterns_in_main_and_overlap() {
    let empty_overlap = DoubleArrayAhoCorasickBuilder::new()
      .build_with_values([("", 7_u32)])
      .unwrap()
      .serialize();
    let valid_overlap = DoubleArrayAhoCorasickBuilder::new()
      .build_with_values([("x", 0_u32)])
      .unwrap()
      .serialize();
    for match_kind in [
      RawMatchKind::Standard,
      RawMatchKind::LeftmostFirst,
      RawMatchKind::LeftmostLongest,
    ] {
      let empty_main = DoubleArrayAhoCorasickBuilder::new()
        .match_kind(match_kind)
        .build_with_values([("", 7_u32)])
        .unwrap()
        .serialize();
      let overlap = if matches!(match_kind, RawMatchKind::Standard) {
        None
      } else {
        Some(valid_overlap.as_slice())
      };
      assert_eq!(
        CaseFoldingAC::from_prepared(
          match_kind,
          false,
          &empty_main,
          overlap,
          PatternDuplicates::default(),
        )
        .err(),
        Some(Error::empty_pattern(7))
      );
      if matches!(match_kind, RawMatchKind::Standard) {
        continue;
      }
      let valid_main = DoubleArrayAhoCorasickBuilder::new()
        .match_kind(match_kind)
        .build_with_values([("x", 0_u32)])
        .unwrap()
        .serialize();
      assert_eq!(
        CaseFoldingAC::from_prepared(
          match_kind,
          false,
          &valid_main,
          Some(&empty_overlap),
          PatternDuplicates::default(),
        )
        .err(),
        Some(Error::empty_pattern(7))
      );
    }
  }
}
