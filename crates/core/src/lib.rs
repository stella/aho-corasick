mod case_folding;

use std::{error, fmt};

use aho_corasick::MatchKind as RawMatchKind;
use case_folding::CaseFoldingAC;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
  BuildAutomaton(String),
  BuildOverlappingAutomaton(String),
  InvalidUtf8Span,
  PatternIndexDoesNotFit,
  PatternCountDoesNotFit,
  MissingReplacement { pattern: u32 },
  ReplacementCountMismatch { expected: u32, actual: usize },
}

impl fmt::Display for Error {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::BuildAutomaton(reason) => {
        write!(f, "Failed to build automaton: {reason}")
      }
      Self::BuildOverlappingAutomaton(reason) => {
        write!(f, "Failed to build overlapping automaton: {reason}")
      }
      Self::InvalidUtf8Span => {
        f.write_str("Search produced an invalid UTF-8 span")
      }
      Self::PatternIndexDoesNotFit => {
        f.write_str("Pattern index does not fit usize")
      }
      Self::PatternCountDoesNotFit => {
        f.write_str("Pattern count does not fit this platform")
      }
      Self::MissingReplacement { pattern } => {
        write!(f, "Missing replacement for pattern {pattern}")
      }
      Self::ReplacementCountMismatch { expected, actual } => {
        write!(f, "Expected {expected} replacements, got {actual}")
      }
    }
  }
}

impl error::Error for Error {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MatchKind {
  LeftmostFirst,
  LeftmostLongest,
}

#[allow(clippy::struct_excessive_bools)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Options {
  pub match_kind: MatchKind,
  pub case_insensitive: bool,
  pub dfa: bool,
  pub whole_words: bool,
}

impl Default for Options {
  fn default() -> Self {
    Self {
      match_kind: MatchKind::LeftmostFirst,
      case_insensitive: false,
      dfa: false,
      whole_words: false,
    }
  }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Match {
  pub pattern: u32,
  pub start: u32,
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
  text.get(start..end).ok_or(Error::InvalidUtf8Span)
}

fn replacement_for(replacements: &[String], pattern: u32) -> Result<&str> {
  let Some(index) = usize_from_u32(pattern) else {
    return Err(Error::PatternIndexDoesNotFit);
  };

  replacements
    .get(index)
    .map(String::as_str)
    .ok_or(Error::MissingReplacement { pattern })
}

const fn char_utf16_len(ch: char) -> u32 {
  if ch.len_utf16() == 1 { 1 } else { 2 }
}

fn is_cjk(ch: char) -> bool {
  matches!(u32::from(ch),
    0x3040..=0x309F
    | 0x30A0..=0x30FF
    | 0x3400..=0x4DBF
    | 0x4E00..=0x9FFF
    | 0xAC00..=0xD7AF
    | 0xF900..=0xFAFF
    | 0x20000..=0x2FA1F
    | 0x30000..=0x323AF
  )
}

fn is_word_char_at(haystack: &str, byte_pos: usize) -> bool {
  if byte_pos >= haystack.len() {
    return false;
  }

  haystack
    .get(byte_pos..)
    .and_then(|tail| tail.chars().next())
    .is_some_and(|ch| ch.is_alphanumeric() && !is_cjk(ch))
}

fn is_word_char_before(haystack: &str, byte_pos: usize) -> bool {
  if byte_pos == 0 {
    return false;
  }

  haystack
    .get(..byte_pos)
    .and_then(|head| head.chars().next_back())
    .is_some_and(|ch| ch.is_alphanumeric() && !is_cjk(ch))
}

fn match_starts_with_cjk(haystack: &str, start: usize) -> bool {
  haystack
    .get(start..)
    .and_then(|tail| tail.chars().next())
    .is_some_and(is_cjk)
}

fn match_ends_with_cjk(haystack: &str, end: usize) -> bool {
  haystack
    .get(..end)
    .and_then(|head| head.chars().next_back())
    .is_some_and(is_cjk)
}

fn is_whole_word(haystack: &str, start: usize, end: usize) -> bool {
  let start_ok = !is_word_char_before(haystack, start)
    || match_starts_with_cjk(haystack, start);
  let end_ok =
    !is_word_char_at(haystack, end) || match_ends_with_cjk(haystack, end);
  start_ok && end_ok
}

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
) -> Vec<u32> {
  let selected = select_leftmost_longest_whole_word_matches(candidates);
  if selected.is_empty() {
    return Vec::new();
  }

  let mut packed = Vec::with_capacity(packed_capacity(selected.len()));
  if haystack.is_ascii() {
    for m in selected {
      packed.push(m.pattern);
      packed.push(u32_from_usize(m.start));
      packed.push(u32_from_usize(m.end));
    }
    return packed;
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

  packed
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

const fn resolve_match_kind(match_kind: MatchKind) -> RawMatchKind {
  match match_kind {
    MatchKind::LeftmostFirst => RawMatchKind::LeftmostFirst,
    MatchKind::LeftmostLongest => RawMatchKind::LeftmostLongest,
  }
}

pub struct AhoCorasick {
  search: CaseFoldingAC,
  whole_words: bool,
  pattern_count: u32,
}

impl AhoCorasick {
  pub fn new(patterns: Vec<String>, options: Options) -> Result<Self> {
    let pattern_count = u32_from_usize(patterns.len());

    let effective_kind = if options.whole_words {
      RawMatchKind::Standard
    } else {
      resolve_match_kind(options.match_kind)
    };

    let search = CaseFoldingAC::build(
      patterns,
      effective_kind,
      options.case_insensitive,
      options.dfa,
    )?;

    Ok(Self {
      search,
      whole_words: options.whole_words,
      pattern_count,
    })
  }

  #[must_use]
  pub const fn pattern_count(&self) -> u32 {
    self.pattern_count
  }

  pub fn is_match(&self, haystack: &str) -> Result<bool> {
    if !self.whole_words {
      let prep = self.search.prepare(haystack);
      return Ok(self.search.is_match_str(&prep));
    }

    let prep = self.search.prepare(haystack);
    for m in self.search.overlapping_find_iter(&prep)? {
      let os = prep.orig_pos(m.start());
      let oe = prep.orig_pos(m.end());
      if is_whole_word(haystack, os, oe) {
        return Ok(true);
      }
    }
    Ok(false)
  }

  pub fn find_iter_packed(&self, haystack: &str) -> Result<Vec<u32>> {
    if !self.whole_words {
      return Ok(self.find_iter_simple(haystack));
    }

    let prep = self.search.prepare(haystack);
    let mut candidates = Vec::new();
    for m in self.search.overlapping_find_iter(&prep)? {
      let os = prep.orig_pos(m.start());
      let oe = prep.orig_pos(m.end());
      if is_whole_word(haystack, os, oe) {
        candidates.push(ByteMatchCandidate {
          pattern: m.pattern().as_u32(),
          start: os,
          end: oe,
        });
      }
    }

    Ok(pack_leftmost_longest_whole_word_matches(
      haystack, candidates,
    ))
  }

  fn find_iter_simple(&self, haystack: &str) -> Vec<u32> {
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
      return packed;
    }

    let bytes = haystack.as_bytes();
    let mut packed = Vec::new();
    let mut last_byte = 0usize;
    let mut last_utf16 = 0u32;

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
    packed
  }

  pub fn find_overlapping_iter_packed(
    &self,
    haystack: &str,
  ) -> Result<Vec<u32>> {
    let prep = self.search.prepare(haystack);

    if haystack.is_ascii() {
      let mut packed = Vec::new();
      for m in self.search.overlapping_find_iter(&prep)? {
        let os = prep.orig_pos(m.start());
        let oe = prep.orig_pos(m.end());
        if self.whole_words && !is_whole_word(haystack, os, oe) {
          continue;
        }
        packed.push(m.pattern().as_u32());
        packed.push(u32_from_usize(os));
        packed.push(u32_from_usize(oe));
      }
      return Ok(packed);
    }

    let raw: Vec<_> = self
      .search
      .overlapping_find_iter(&prep)?
      .filter(|m| {
        let os = prep.orig_pos(m.start());
        let oe = prep.orig_pos(m.end());
        !self.whole_words || is_whole_word(haystack, os, oe)
      })
      .collect();

    if raw.is_empty() {
      return Ok(Vec::new());
    }

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
    let mut utf16_idx = 0u32;
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
    Ok(packed)
  }

  pub fn replace_all(
    &self,
    haystack: &str,
    replacements: &[String],
  ) -> Result<String> {
    let Some(expected_replacements) = usize_from_u32(self.pattern_count) else {
      return Err(Error::PatternCountDoesNotFit);
    };

    if replacements.len() != expected_replacements {
      return Err(Error::ReplacementCountMismatch {
        expected: self.pattern_count,
        actual: replacements.len(),
      });
    }

    let prep = self.search.prepare(haystack);

    if !self.whole_words {
      let mut result = String::with_capacity(haystack.len());
      let mut last = 0usize;
      for m in self.search.find_iter(&prep) {
        let os = prep.orig_pos(m.start());
        let oe = prep.orig_pos(m.end());
        result.push_str(str_span(haystack, last, os)?);
        result.push_str(replacement_for(replacements, m.pattern().as_u32())?);
        last = oe;
      }
      result.push_str(str_span(haystack, last, haystack.len())?);
      return Ok(result);
    }

    let mut candidates = Vec::new();
    for m in self.search.overlapping_find_iter(&prep)? {
      let os = prep.orig_pos(m.start());
      let oe = prep.orig_pos(m.end());
      if is_whole_word(haystack, os, oe) {
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
      result.push_str(str_span(haystack, last_orig, m.start)?);
      result.push_str(replacement_for(replacements, m.pattern)?);
      last_orig = m.end;
    }
    result.push_str(str_span(haystack, last_orig, haystack.len())?);
    Ok(result)
  }

  #[must_use]
  pub fn find_iter_buf(&self, haystack: &[u8]) -> Vec<Match> {
    let prep = self.search.prepare_bytes(haystack);
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

  #[must_use]
  pub fn find_iter_packed_buf(&self, haystack: &[u8]) -> Vec<u32> {
    let prep = self.search.prepare_bytes(haystack);
    let mut packed = Vec::new();
    for m in self.search.find_iter_bytes(&prep) {
      packed.push(m.pattern().as_u32());
      packed.push(u32_from_usize(prep.orig_pos(m.start())));
      packed.push(u32_from_usize(prep.orig_pos(m.end())));
    }
    packed
  }

  #[must_use]
  pub fn is_match_buf(&self, haystack: &[u8]) -> bool {
    let prep = self.search.prepare_bytes(haystack);
    self.search.is_match_bytes_prep(&prep)
  }

  #[must_use]
  pub fn find_in_chunk(&self, chunk: &[u8]) -> Vec<Match> {
    self.find_iter_buf(chunk)
  }
}

pub struct StreamMatcher {
  search: CaseFoldingAC,
  max_pattern_len: usize,
  overlap_buf: Vec<u8>,
  global_offset: usize,
}

impl StreamMatcher {
  pub fn new(patterns: Vec<String>, options: Options) -> Result<Self> {
    let max_pattern_len = patterns.iter().map(String::len).max().unwrap_or(0);
    let search = CaseFoldingAC::build(
      patterns,
      resolve_match_kind(options.match_kind),
      options.case_insensitive,
      options.dfa,
    )?;

    Ok(Self {
      search,
      max_pattern_len,
      overlap_buf: Vec::new(),
      global_offset: 0,
    })
  }

  pub fn write(&mut self, chunk: &[u8]) -> Vec<Match> {
    if self.max_pattern_len <= 1 {
      let prep = self.search.prepare_bytes(chunk);
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
      self.global_offset = self.global_offset.saturating_add(chunk.len());
      return matches;
    }

    let overlap_len = self.overlap_buf.len();
    let mut combined =
      Vec::with_capacity(overlap_len.saturating_add(chunk.len()));
    combined.extend_from_slice(&self.overlap_buf);
    combined.extend_from_slice(chunk);

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
    self.global_offset = self.global_offset.saturating_add(chunk.len());
    matches
  }

  #[must_use]
  pub fn flush(&mut self) -> Vec<Match> {
    self.overlap_buf.clear();
    self.global_offset = 0;
    Vec::new()
  }

  pub fn reset(&mut self) {
    self.overlap_buf.clear();
    self.global_offset = 0;
  }
}
