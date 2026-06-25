#![allow(clippy::redundant_pub_crate)]

use std::{collections::HashSet, sync::OnceLock};

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

fn effective_pattern_values(
  patterns: Vec<String>,
  case_insensitive: bool,
) -> Result<Vec<(String, u32)>, Error> {
  let mut seen = HashSet::with_capacity(patterns.len());
  let mut values = Vec::with_capacity(patterns.len());

  for (index, mut pattern) in patterns.into_iter().enumerate() {
    let index =
      u32::try_from(index).map_err(|_| Error::PatternIndexDoesNotFit)?;
    if case_insensitive {
      if pattern.is_ascii() {
        pattern.make_ascii_lowercase();
      } else {
        pattern = simple_fold_string(&pattern);
      }
    }
    if seen.insert(pattern.clone()) {
      values.push((pattern, index));
    }
  }

  Ok(values)
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

    let folded = simple_fold_string(haystack);
    if folded.len() == haystack.len() {
      return Self {
        folded,
        mapping: PosMapping::Identity,
      };
    }

    Self::build_mapped(haystack)
  }

  fn build_mapped(original: &str) -> Self {
    let mut folded = String::with_capacity(original.len());
    let mut mapping = Vec::with_capacity(original.len().saturating_add(1));

    for (orig_pos, ch) in original.char_indices() {
      let before = folded.len();
      folded.push(simple_case_fold(ch));
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

pub(crate) struct PreparedAutomata {
  pub(crate) main: Vec<u8>,
  pub(crate) overlap: Option<Vec<u8>>,
}

impl CaseFoldingAC {
  pub(crate) fn build(
    patterns: Vec<String>,
    match_kind: RawMatchKind,
    case_insensitive: bool,
    _dfa: bool,
  ) -> Result<Self, Error> {
    let pattern_values = effective_pattern_values(patterns, case_insensitive)?;
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
    })
  }

  pub(crate) fn from_prepared(
    match_kind: RawMatchKind,
    case_insensitive: bool,
    main: &[u8],
    overlap: Option<&[u8]>,
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
    })
  }

  pub(crate) fn prepared_automata(&self) -> Result<PreparedAutomata, Error> {
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

    Ok(PreparedAutomata { main, overlap })
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
    find_iter_raw(
      self.raw.as_ref(),
      self.match_kind,
      prep.search_text().as_bytes(),
    )
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
    Ok(overlapping_iter_raw(
      automaton,
      prep.search_text().as_bytes(),
    ))
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
