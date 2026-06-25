use std::panic;

use napi::bindgen_prelude::{Buffer, Error, Result, Uint32Array};
use napi_derive::napi;
use stella_aho_corasick_core as core;

fn panic_to_napi_error(payload: &(dyn std::any::Any + Send)) -> Error {
  let msg = payload
    .downcast_ref::<&str>()
    .copied()
    .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
    .unwrap_or("unknown panic");
  Error::from_reason(format!("Rust panic: {msg}"))
}

fn core_to_napi_error(error: &core::Error) -> Error {
  Error::from_reason(error.to_string())
}

#[derive(Clone, Copy)]
#[napi(string_enum)]
pub enum MatchKind {
  #[napi(value = "leftmost-first")]
  LeftmostFirst,
  #[napi(value = "leftmost-longest")]
  LeftmostLongest,
}

impl From<MatchKind> for core::MatchKind {
  fn from(value: MatchKind) -> Self {
    match value {
      MatchKind::LeftmostFirst => Self::LeftmostFirst,
      MatchKind::LeftmostLongest => Self::LeftmostLongest,
    }
  }
}

#[napi(object)]
pub struct Options {
  pub match_kind: Option<MatchKind>,
  pub case_insensitive: Option<bool>,
  pub dfa: Option<bool>,
  pub whole_words: Option<bool>,
  pub unicode_boundaries: Option<bool>,
}

#[napi(object)]
pub struct Match {
  pub pattern: u32,
  pub start: u32,
  pub end: u32,
}

impl From<core::Match> for Match {
  fn from(value: core::Match) -> Self {
    Self {
      pattern: value.pattern,
      start: value.start,
      end: value.end,
    }
  }
}

const fn default_options() -> Options {
  Options {
    match_kind: None,
    case_insensitive: None,
    dfa: None,
    whole_words: None,
    unicode_boundaries: None,
  }
}

fn resolve_options(options: Option<Options>) -> core::Options {
  let opts = options.unwrap_or_else(default_options);
  core::Options {
    match_kind: opts
      .match_kind
      .map_or(core::MatchKind::LeftmostFirst, core::MatchKind::from),
    case_insensitive: opts.case_insensitive.unwrap_or(false),
    dfa: opts.dfa.unwrap_or(false),
    whole_words: opts.whole_words.unwrap_or(false),
    unicode_boundaries: opts.unicode_boundaries.unwrap_or(true),
  }
}

#[napi(js_name = "prepareAhoCorasick")]
#[allow(clippy::needless_pass_by_value)]
pub fn prepare_aho_corasick(
  patterns: Vec<String>,
  options: Option<Options>,
) -> Result<Buffer> {
  panic::catch_unwind(|| {
    core::AhoCorasick::prepare(patterns, resolve_options(options))
      .map(Buffer::from)
      .map_err(|error| core_to_napi_error(&error))
  })
  .unwrap_or_else(|e| Err(panic_to_napi_error(e.as_ref())))
}

#[napi(js_name = "ahoCorasickFromPrepared")]
#[allow(clippy::needless_pass_by_value)]
pub fn aho_corasick_from_prepared(bytes: Buffer) -> Result<AhoCorasick> {
  panic::catch_unwind(|| {
    core::AhoCorasick::from_prepared(bytes.as_ref())
      .map(|inner| AhoCorasick { inner })
      .map_err(|error| core_to_napi_error(&error))
  })
  .unwrap_or_else(|e| Err(panic_to_napi_error(e.as_ref())))
}

#[napi]
pub struct AhoCorasick {
  inner: core::AhoCorasick,
}

#[napi]
#[allow(clippy::needless_pass_by_value)]
impl AhoCorasick {
  #[napi(constructor)]
  pub fn new(patterns: Vec<String>, options: Option<Options>) -> Result<Self> {
    panic::catch_unwind(|| Self::new_inner(patterns, options))
      .unwrap_or_else(|e| Err(panic_to_napi_error(e.as_ref())))
  }

  fn new_inner(
    patterns: Vec<String>,
    options: Option<Options>,
  ) -> Result<Self> {
    let inner = core::AhoCorasick::new(patterns, resolve_options(options))
      .map_err(|error| core_to_napi_error(&error))?;
    Ok(Self { inner })
  }

  #[napi(getter)]
  #[must_use]
  pub const fn pattern_count(&self) -> u32 {
    self.inner.pattern_count()
  }

  #[napi(js_name = "toPrepared")]
  pub fn to_prepared(&self) -> Result<Buffer> {
    self
      .inner
      .to_prepared()
      .map(Buffer::from)
      .map_err(|error| core_to_napi_error(&error))
  }

  #[napi]
  pub fn is_match(&self, haystack: String) -> Result<bool> {
    self
      .inner
      .is_match(&haystack)
      .map_err(|error| core_to_napi_error(&error))
  }

  #[napi(js_name = "_findIterPacked")]
  pub fn find_iter_packed(&self, haystack: String) -> Result<Uint32Array> {
    self
      .inner
      .find_iter_packed(&haystack)
      .map(Uint32Array::new)
      .map_err(|error| core_to_napi_error(&error))
  }

  #[napi(js_name = "_findOverlappingIterPacked")]
  pub fn find_overlapping_iter_packed(
    &self,
    haystack: String,
  ) -> Result<Uint32Array> {
    self
      .inner
      .find_overlapping_iter_packed(&haystack)
      .map(Uint32Array::new)
      .map_err(|error| core_to_napi_error(&error))
  }

  #[napi]
  pub fn replace_all(
    &self,
    haystack: String,
    replacements: Vec<String>,
  ) -> Result<String> {
    self
      .inner
      .replace_all(&haystack, &replacements)
      .map_err(|error| core_to_napi_error(&error))
  }

  #[napi]
  #[must_use]
  pub fn find_iter_buf(&self, haystack: Buffer) -> Vec<Match> {
    self
      .inner
      .find_iter_buf(haystack.as_ref())
      .into_iter()
      .map(Match::from)
      .collect()
  }

  #[napi(js_name = "_findIterPackedBuf")]
  #[must_use]
  pub fn find_iter_packed_buf(&self, haystack: Buffer) -> Uint32Array {
    Uint32Array::new(self.inner.find_iter_packed_buf(haystack.as_ref()))
  }

  #[napi]
  #[must_use]
  pub fn is_match_buf(&self, haystack: Buffer) -> bool {
    self.inner.is_match_buf(haystack.as_ref())
  }

  #[napi]
  #[must_use]
  pub fn find_in_chunk(&self, chunk: Buffer) -> Vec<Match> {
    self
      .inner
      .find_in_chunk(chunk.as_ref())
      .into_iter()
      .map(Match::from)
      .collect()
  }
}

#[napi]
pub struct StreamMatcher {
  inner: core::StreamMatcher,
}

#[napi]
#[allow(clippy::needless_pass_by_value)]
impl StreamMatcher {
  #[napi(constructor)]
  pub fn new(patterns: Vec<String>, options: Option<Options>) -> Result<Self> {
    panic::catch_unwind(|| Self::new_inner(patterns, options))
      .unwrap_or_else(|e| Err(panic_to_napi_error(e.as_ref())))
  }

  fn new_inner(
    patterns: Vec<String>,
    options: Option<Options>,
  ) -> Result<Self> {
    let inner = core::StreamMatcher::new(patterns, resolve_options(options))
      .map_err(|error| core_to_napi_error(&error))?;
    Ok(Self { inner })
  }

  #[napi]
  pub fn write(&mut self, chunk: Buffer) -> Vec<Match> {
    self
      .inner
      .write(chunk.as_ref())
      .into_iter()
      .map(Match::from)
      .collect()
  }

  #[napi]
  pub fn flush(&mut self) -> Vec<Match> {
    self.inner.flush().into_iter().map(Match::from).collect()
  }

  #[napi]
  pub fn reset(&mut self) {
    self.inner.reset();
  }
}
