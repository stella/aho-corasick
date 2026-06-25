mod case_folding;

use std::{error, fmt};

use case_folding::CaseFoldingAC;
use daachorse::MatchKind as RawMatchKind;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
  BuildAutomaton(String),
  BuildOverlappingAutomaton(String),
  InvalidPreparedAutomaton(String),
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
      Self::InvalidPreparedAutomaton(reason) => {
        write!(f, "Invalid prepared automaton: {reason}")
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
  pub unicode_boundaries: bool,
}

impl Default for Options {
  fn default() -> Self {
    Self {
      match_kind: MatchKind::LeftmostFirst,
      case_insensitive: false,
      dfa: false,
      whole_words: false,
      unicode_boundaries: true,
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

#[derive(Clone, Copy)]
enum BoundaryMode {
  Unicode,
  Ascii,
}

const MATCH_FIELDS: usize = 3;
const PREPARED_MAGIC: &[u8; 8] = b"STLAHO\0\0";
const PREPARED_VERSION: u32 = 1;
const PREPARED_HEADER_LEN: usize = 28;
const PREPARED_FLAG_CASE_INSENSITIVE: u8 = 1;
const PREPARED_FLAG_WHOLE_WORDS: u8 = 2;
const PREPARED_FLAG_ASCII_BOUNDARIES: u8 = 4;
const PREPARED_KNOWN_FLAGS: u8 = PREPARED_FLAG_CASE_INSENSITIVE
  | PREPARED_FLAG_WHOLE_WORDS
  | PREPARED_FLAG_ASCII_BOUNDARIES;
const RAW_MATCH_STANDARD: u8 = 0;
const RAW_MATCH_LEFTMOST_LONGEST: u8 = 1;
const RAW_MATCH_LEFTMOST_FIRST: u8 = 2;

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

fn invalid_prepared(reason: &str) -> Error {
  Error::InvalidPreparedAutomaton(reason.to_owned())
}

fn read_u32_le(bytes: &[u8], cursor: &mut usize, field: &str) -> Result<u32> {
  let end = cursor
    .checked_add(4)
    .ok_or_else(|| invalid_prepared("offset overflow"))?;
  let Some(value) = bytes.get(*cursor..end) else {
    return Err(invalid_prepared(field));
  };
  let array: [u8; 4] = value.try_into().map_err(|_| invalid_prepared(field))?;
  *cursor = end;
  Ok(u32::from_le_bytes(array))
}

fn read_u8(bytes: &[u8], cursor: &mut usize, field: &str) -> Result<u8> {
  let Some(value) = bytes.get(*cursor).copied() else {
    return Err(invalid_prepared(field));
  };
  *cursor = cursor.saturating_add(1);
  Ok(value)
}

fn skip_reserved(bytes: &[u8], cursor: &mut usize) -> Result<()> {
  let end = cursor
    .checked_add(2)
    .ok_or_else(|| invalid_prepared("offset overflow"))?;
  let Some(reserved) = bytes.get(*cursor..end) else {
    return Err(invalid_prepared("missing reserved bytes"));
  };
  if reserved.iter().any(|byte| *byte != 0) {
    return Err(invalid_prepared("reserved bytes must be zero"));
  }
  *cursor = end;
  Ok(())
}

fn read_bytes<'a>(
  bytes: &'a [u8],
  cursor: &mut usize,
  len: usize,
  field: &str,
) -> Result<&'a [u8]> {
  let end = cursor
    .checked_add(len)
    .ok_or_else(|| invalid_prepared("offset overflow"))?;
  let Some(value) = bytes.get(*cursor..end) else {
    return Err(invalid_prepared(field));
  };
  *cursor = end;
  Ok(value)
}

fn write_u32_le(bytes: &mut Vec<u8>, value: u32) {
  bytes.extend_from_slice(&value.to_le_bytes());
}

const fn raw_match_kind_byte(match_kind: RawMatchKind) -> u8 {
  match match_kind {
    RawMatchKind::Standard => RAW_MATCH_STANDARD,
    RawMatchKind::LeftmostLongest => RAW_MATCH_LEFTMOST_LONGEST,
    RawMatchKind::LeftmostFirst => RAW_MATCH_LEFTMOST_FIRST,
  }
}

fn raw_match_kind_from_byte(value: u8) -> Result<RawMatchKind> {
  match value {
    RAW_MATCH_STANDARD => Ok(RawMatchKind::Standard),
    RAW_MATCH_LEFTMOST_LONGEST => Ok(RawMatchKind::LeftmostLongest),
    RAW_MATCH_LEFTMOST_FIRST => Ok(RawMatchKind::LeftmostFirst),
    _ => Err(invalid_prepared("unknown match kind")),
  }
}

const fn prepared_flags(
  case_insensitive: bool,
  whole_words: bool,
  boundary_mode: BoundaryMode,
) -> u8 {
  let mut flags = 0u8;
  if case_insensitive {
    flags |= PREPARED_FLAG_CASE_INSENSITIVE;
  }
  if whole_words {
    flags |= PREPARED_FLAG_WHOLE_WORDS;
  }
  if matches!(boundary_mode, BoundaryMode::Ascii) {
    flags |= PREPARED_FLAG_ASCII_BOUNDARIES;
  }
  flags
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

const fn is_ascii_word_byte(byte: u8) -> bool {
  matches!(byte, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_')
}

fn is_word_char_at(
  haystack: &str,
  byte_pos: usize,
  boundary_mode: BoundaryMode,
) -> bool {
  match boundary_mode {
    BoundaryMode::Ascii => haystack
      .as_bytes()
      .get(byte_pos)
      .is_some_and(|byte| is_ascii_word_byte(*byte)),
    BoundaryMode::Unicode => haystack
      .get(byte_pos..)
      .and_then(|tail| tail.chars().next())
      .is_some_and(|ch| ch.is_alphanumeric() && !is_cjk(ch)),
  }
}

fn is_word_char_before(
  haystack: &str,
  byte_pos: usize,
  boundary_mode: BoundaryMode,
) -> bool {
  match boundary_mode {
    BoundaryMode::Ascii => byte_pos
      .checked_sub(1)
      .and_then(|index| haystack.as_bytes().get(index))
      .is_some_and(|byte| is_ascii_word_byte(*byte)),
    BoundaryMode::Unicode => haystack
      .get(..byte_pos)
      .and_then(|head| head.chars().next_back())
      .is_some_and(|ch| ch.is_alphanumeric() && !is_cjk(ch)),
  }
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

fn is_whole_word(
  haystack: &str,
  start: usize,
  end: usize,
  boundary_mode: BoundaryMode,
) -> bool {
  let cjk_start = matches!(boundary_mode, BoundaryMode::Unicode)
    && match_starts_with_cjk(haystack, start);
  let cjk_end = matches!(boundary_mode, BoundaryMode::Unicode)
    && match_ends_with_cjk(haystack, end);
  let start_ok =
    !is_word_char_before(haystack, start, boundary_mode) || cjk_start;
  let end_ok = !is_word_char_at(haystack, end, boundary_mode) || cjk_end;
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
  boundary_mode: BoundaryMode,
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
      boundary_mode: if options.unicode_boundaries {
        BoundaryMode::Unicode
      } else {
        BoundaryMode::Ascii
      },
      pattern_count,
    })
  }

  pub fn prepare(patterns: Vec<String>, options: Options) -> Result<Vec<u8>> {
    Self::new(patterns, options)?.to_prepared()
  }

  pub fn from_prepared(bytes: &[u8]) -> Result<Self> {
    let Some(magic) = bytes.get(..PREPARED_MAGIC.len()) else {
      return Err(invalid_prepared("missing magic"));
    };
    if magic != PREPARED_MAGIC {
      return Err(invalid_prepared("magic mismatch"));
    }

    let mut cursor = PREPARED_MAGIC.len();
    let version = read_u32_le(bytes, &mut cursor, "missing version")?;
    if version != PREPARED_VERSION {
      return Err(invalid_prepared("unsupported version"));
    }

    let pattern_count =
      read_u32_le(bytes, &mut cursor, "missing pattern count")?;
    let match_kind = raw_match_kind_from_byte(read_u8(
      bytes,
      &mut cursor,
      "missing match kind",
    )?)?;
    let flags = read_u8(bytes, &mut cursor, "missing flags")?;
    if flags & !PREPARED_KNOWN_FLAGS != 0 {
      return Err(invalid_prepared("unknown flags"));
    }
    skip_reserved(bytes, &mut cursor)?;

    let main_len = read_u32_le(bytes, &mut cursor, "missing main length")?;
    let overlap_len =
      read_u32_le(bytes, &mut cursor, "missing overlap length")?;
    debug_assert_eq!(
      cursor, PREPARED_HEADER_LEN,
      "prepared header cursor must match header length"
    );

    let Some(main_len) = usize_from_u32(main_len) else {
      return Err(invalid_prepared("main length does not fit"));
    };
    let Some(overlap_len) = usize_from_u32(overlap_len) else {
      return Err(invalid_prepared("overlap length does not fit"));
    };

    let main = read_bytes(bytes, &mut cursor, main_len, "missing main bytes")?;
    let overlap =
      read_bytes(bytes, &mut cursor, overlap_len, "missing overlap bytes")?;
    if cursor != bytes.len() {
      return Err(invalid_prepared("trailing bytes"));
    }

    let case_insensitive = flags & PREPARED_FLAG_CASE_INSENSITIVE != 0;
    let whole_words = flags & PREPARED_FLAG_WHOLE_WORDS != 0;
    let boundary_mode = if flags & PREPARED_FLAG_ASCII_BOUNDARIES == 0 {
      BoundaryMode::Unicode
    } else {
      BoundaryMode::Ascii
    };
    let overlap = if matches!(match_kind, RawMatchKind::Standard) {
      if !overlap.is_empty() {
        return Err(invalid_prepared(
          "standard automaton includes overlap bytes",
        ));
      }
      None
    } else {
      if overlap.is_empty() {
        return Err(invalid_prepared(
          "non-standard automaton is missing overlap bytes",
        ));
      }
      Some(overlap)
    };
    let search = CaseFoldingAC::from_prepared(
      match_kind,
      case_insensitive,
      main,
      overlap,
    )?;

    Ok(Self {
      search,
      whole_words,
      boundary_mode,
      pattern_count,
    })
  }

  pub fn to_prepared(&self) -> Result<Vec<u8>> {
    let prepared = self.search.prepared_automata()?;
    let main_len = u32::try_from(prepared.main.len())
      .map_err(|_| invalid_prepared("main automaton too large"))?;
    let overlap_len =
      u32::try_from(prepared.overlap.as_ref().map_or(0usize, Vec::len))
        .map_err(|_| invalid_prepared("overlap automaton too large"))?;

    let mut bytes = Vec::with_capacity(
      PREPARED_HEADER_LEN
        .saturating_add(prepared.main.len())
        .saturating_add(prepared.overlap.as_ref().map_or(0usize, Vec::len)),
    );
    bytes.extend_from_slice(PREPARED_MAGIC);
    write_u32_le(&mut bytes, PREPARED_VERSION);
    write_u32_le(&mut bytes, self.pattern_count);
    bytes.push(raw_match_kind_byte(self.search.match_kind()));
    bytes.push(prepared_flags(
      self.search.case_insensitive(),
      self.whole_words,
      self.boundary_mode,
    ));
    bytes.extend_from_slice(&[0, 0]);
    write_u32_le(&mut bytes, main_len);
    write_u32_le(&mut bytes, overlap_len);
    bytes.extend_from_slice(&prepared.main);
    if let Some(overlap) = prepared.overlap {
      bytes.extend_from_slice(&overlap);
    }
    Ok(bytes)
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
      if is_whole_word(haystack, os, oe, self.boundary_mode) {
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
      if is_whole_word(haystack, os, oe, self.boundary_mode) {
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

  /// Like [`find_iter_packed`](Self::find_iter_packed) but emits UTF-8 byte
  /// offsets instead of UTF-16 code-unit offsets.
  ///
  /// The engine produces byte offsets internally, so this skips the UTF-16
  /// conversion `find_iter_packed` performs. It is the native unit for Rust
  /// consumers that slice `&str` directly; UTF-16 consumers (e.g. JavaScript)
  /// keep using [`find_iter_packed`](Self::find_iter_packed).
  pub fn find_iter_packed_bytes(&self, haystack: &str) -> Result<Vec<u32>> {
    let prep = self.search.prepare(haystack);

    if !self.whole_words {
      let mut packed = Vec::new();
      for m in self.search.find_iter(&prep) {
        packed.push(m.pattern().as_u32());
        packed.push(u32_from_usize(prep.orig_pos(m.start())));
        packed.push(u32_from_usize(prep.orig_pos(m.end())));
      }
      return Ok(packed);
    }

    let mut candidates = Vec::new();
    for m in self.search.overlapping_find_iter(&prep)? {
      let os = prep.orig_pos(m.start());
      let oe = prep.orig_pos(m.end());
      if is_whole_word(haystack, os, oe, self.boundary_mode) {
        candidates.push(ByteMatchCandidate {
          pattern: m.pattern().as_u32(),
          start: os,
          end: oe,
        });
      }
    }

    let selected = select_leftmost_longest_whole_word_matches(candidates);
    let mut packed = Vec::with_capacity(packed_capacity(selected.len()));
    for m in selected {
      packed.push(m.pattern);
      packed.push(u32_from_usize(m.start));
      packed.push(u32_from_usize(m.end));
    }
    Ok(packed)
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
        if self.whole_words
          && !is_whole_word(haystack, os, oe, self.boundary_mode)
        {
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
      .into_iter()
      .filter(|m| {
        let os = prep.orig_pos(m.start());
        let oe = prep.orig_pos(m.end());
        !self.whole_words || is_whole_word(haystack, os, oe, self.boundary_mode)
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

  /// Like [`find_overlapping_iter_packed`](Self::find_overlapping_iter_packed)
  /// but emits UTF-8 byte offsets instead of UTF-16 code-unit offsets.
  pub fn find_overlapping_iter_packed_bytes(
    &self,
    haystack: &str,
  ) -> Result<Vec<u32>> {
    let prep = self.search.prepare(haystack);
    let mut packed = Vec::new();
    for m in self.search.overlapping_find_iter(&prep)? {
      let os = prep.orig_pos(m.start());
      let oe = prep.orig_pos(m.end());
      if self.whole_words
        && !is_whole_word(haystack, os, oe, self.boundary_mode)
      {
        continue;
      }
      packed.push(m.pattern().as_u32());
      packed.push(u32_from_usize(os));
      packed.push(u32_from_usize(oe));
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
      if is_whole_word(haystack, os, oe, self.boundary_mode) {
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
      .into_iter()
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
        .into_iter()
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

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::missing_assert_message)]
mod tests {
  use super::{AhoCorasick, MatchKind, Options};

  #[test]
  fn packed_bytes_emit_byte_offsets() {
    // `ä` is 2 UTF-8 bytes but 1 UTF-16 code unit, so the units diverge.
    let ac =
      AhoCorasick::new(vec![String::from("b")], Options::default()).unwrap();

    // Existing packed output is UTF-16: [pattern, start, end] = [0, 1, 2].
    assert_eq!(ac.find_iter_packed("äb").unwrap(), vec![0, 1, 2]);
    // Byte variant reports byte offsets: [0, 2, 3].
    assert_eq!(ac.find_iter_packed_bytes("äb").unwrap(), vec![0, 2, 3]);
    assert_eq!(
      ac.find_overlapping_iter_packed_bytes("äb").unwrap(),
      vec![0, 2, 3]
    );
  }

  #[test]
  fn prepared_roundtrip_preserves_matching() {
    let options = Options {
      match_kind: MatchKind::LeftmostLongest,
      case_insensitive: true,
      whole_words: true,
      unicode_boundaries: true,
      ..Options::default()
    };
    let patterns = vec![String::from("istanbul"), String::from("city")];
    let direct = AhoCorasick::new(patterns.clone(), options).unwrap();
    let prepared_bytes = AhoCorasick::prepare(patterns, options).unwrap();
    let prepared = AhoCorasick::from_prepared(&prepared_bytes).unwrap();
    let haystack = "Visit İstanbul city today";

    assert_eq!(
      direct.find_iter_packed(haystack).unwrap(),
      prepared.find_iter_packed(haystack).unwrap()
    );
    assert_eq!(
      direct
        .replace_all(haystack, &[String::from("X"), String::from("Y")])
        .unwrap(),
      prepared
        .replace_all(haystack, &[String::from("X"), String::from("Y")])
        .unwrap()
    );
  }

  #[test]
  fn prepared_roundtrip_preserves_ascii_boundaries() {
    let options = Options {
      whole_words: true,
      unicode_boundaries: false,
      ..Options::default()
    };
    let patterns = vec![String::from("idea")];
    let direct = AhoCorasick::new(patterns.clone(), options).unwrap();
    let prepared_bytes = AhoCorasick::prepare(patterns, options).unwrap();
    let prepared = AhoCorasick::from_prepared(&prepared_bytes).unwrap();

    assert_eq!(
      direct.find_iter_packed("нетidea ok").unwrap(),
      prepared.find_iter_packed("нетidea ok").unwrap()
    );
    assert_eq!(prepared.find_iter_packed("нетidea ok").unwrap().len(), 3);
  }

  #[test]
  fn prepared_rejects_invalid_bytes() {
    let result = AhoCorasick::from_prepared(b"nope");

    assert!(result.is_err(), "invalid prepared bytes should fail");
    let message = result
      .err()
      .map_or_else(String::new, |error| error.to_string());
    assert!(
      message.contains("Invalid prepared automaton"),
      "error should explain that the prepared automaton is invalid"
    );
  }

  #[test]
  fn prepared_rejects_missing_overlap_bytes_for_non_standard_match_kind() {
    let options = Options {
      match_kind: MatchKind::LeftmostFirst,
      ..Options::default()
    };
    let mut bytes =
      AhoCorasick::prepare(vec![String::from("alpha")], options).unwrap();
    let main_len_offset = 20usize;
    let overlap_len_offset = 24usize;
    let main_len_bytes: [u8; 4] = bytes
      .get(main_len_offset..overlap_len_offset)
      .unwrap()
      .try_into()
      .unwrap();
    let main_len = usize::try_from(u32::from_le_bytes(main_len_bytes)).unwrap();
    bytes
      .get_mut(overlap_len_offset..overlap_len_offset + 4)
      .unwrap()
      .copy_from_slice(&0u32.to_le_bytes());
    bytes.truncate(28usize.saturating_add(main_len));

    let result = AhoCorasick::from_prepared(&bytes);

    assert!(
      result.is_err(),
      "non-standard prepared automata must carry overlap bytes"
    );
    let message = result
      .err()
      .map_or_else(String::new, |error| error.to_string());
    assert!(
      message.contains("missing overlap bytes"),
      "error should explain that overlap bytes are required"
    );
  }
}
