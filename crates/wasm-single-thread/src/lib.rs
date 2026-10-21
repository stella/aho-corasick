use std::{cell::RefCell, collections::HashMap, mem};

use stella_aho_corasick_core::{
  AhoCorasick, Match, MatchKind, Options, StreamMatcher,
};

type Result<T> = std::result::Result<T, String>;
const U32_BYTES: usize = 4;
const MATCH_BYTES: usize = 12;
const FLAG_LONGEST: u32 = 1;
const FLAG_CASE_INSENSITIVE: u32 = 2;
const FLAG_DFA: u32 = 4;
const FLAG_WHOLE_WORDS: u32 = 8;
const FLAG_ASCII_BOUNDARIES: u32 = 16;
const KNOWN_FLAGS: u32 = FLAG_LONGEST
  | FLAG_CASE_INSENSITIVE
  | FLAG_DFA
  | FLAG_WHOLE_WORDS
  | FLAG_ASCII_BOUNDARIES;

#[derive(Clone, Copy)]
enum Operation {
  New,
  Prepare,
  FromPrepared,
  PatternCount,
  IsMatch,
  FindIter,
  FindOverlappingIter,
  ReplaceAll,
  FindIterBuf,
  IsMatchBuf,
  ToPrepared,
  StreamNew,
  StreamWrite,
  StreamFlush,
  StreamReset,
  Free,
}

impl TryFrom<u32> for Operation {
  type Error = String;
  fn try_from(value: u32) -> Result<Self> {
    match value {
      1 => Ok(Self::New),
      2 => Ok(Self::Prepare),
      3 => Ok(Self::FromPrepared),
      4 => Ok(Self::PatternCount),
      5 => Ok(Self::IsMatch),
      6 => Ok(Self::FindIter),
      7 => Ok(Self::FindOverlappingIter),
      8 => Ok(Self::ReplaceAll),
      9 => Ok(Self::FindIterBuf),
      10 => Ok(Self::IsMatchBuf),
      11 => Ok(Self::ToPrepared),
      12 => Ok(Self::StreamNew),
      13 => Ok(Self::StreamWrite),
      14 => Ok(Self::StreamFlush),
      15 => Ok(Self::StreamReset),
      16 => Ok(Self::Free),
      _ => Err("unknown operation".to_owned()),
    }
  }
}

struct Reader<'a> {
  remaining: &'a [u8],
}

impl<'a> Reader<'a> {
  fn take(&mut self, len: usize) -> Result<&'a [u8]> {
    let (value, rest) = self
      .remaining
      .split_at_checked(len)
      .ok_or_else(|| "truncated request".to_owned())?;
    self.remaining = rest;
    Ok(value)
  }

  fn u32(&mut self) -> Result<u32> {
    let bytes = self
      .take(U32_BYTES)?
      .try_into()
      .map_err(|_| "invalid u32".to_owned())?;
    Ok(u32::from_le_bytes(bytes))
  }
}

struct Request<'a> {
  operation: Operation,
  id: u32,
  options: Options,
  strings: Vec<&'a str>,
  payload: &'a [u8],
}

impl<'a> Request<'a> {
  fn parse(input: &'a [u8]) -> Result<Self> {
    let mut reader = Reader { remaining: input };
    let operation = Operation::try_from(reader.u32()?)?;
    let id = reader.u32()?;
    let flags = reader.u32()?;
    if flags & !KNOWN_FLAGS != 0 {
      return Err("unknown option flags".to_owned());
    }
    let count = reader.u32()?;
    let mut strings = Vec::new();
    for _ in 0..count {
      let len = usize::try_from(reader.u32()?)
        .map_err(|_| "string length does not fit".to_owned())?;
      strings.push(
        std::str::from_utf8(reader.take(len)?)
          .map_err(|error| error.to_string())?,
      );
    }
    let request = Self {
      operation,
      id,
      strings,
      payload: reader.remaining,
      options: Options {
        match_kind: if flags & FLAG_LONGEST == 0 {
          MatchKind::LeftmostFirst
        } else {
          MatchKind::LeftmostLongest
        },
        case_insensitive: flags & FLAG_CASE_INSENSITIVE != 0,
        dfa: flags & FLAG_DFA != 0,
        whole_words: flags & FLAG_WHOLE_WORDS != 0,
        unicode_boundaries: flags & FLAG_ASCII_BOUNDARIES == 0,
      },
    };
    request.validate_shape()?;
    Ok(request)
  }

  fn validate_shape(&self) -> Result<()> {
    let valid_strings = match self.operation {
      Operation::New | Operation::Prepare | Operation::StreamNew => true,
      Operation::IsMatch
      | Operation::FindIter
      | Operation::FindOverlappingIter => self.strings.len() == 1,
      Operation::ReplaceAll => !self.strings.is_empty(),
      Operation::FromPrepared
      | Operation::PatternCount
      | Operation::FindIterBuf
      | Operation::IsMatchBuf
      | Operation::ToPrepared
      | Operation::StreamWrite
      | Operation::StreamFlush
      | Operation::StreamReset
      | Operation::Free => self.strings.is_empty(),
    };
    let valid_payload = match self.operation {
      Operation::FromPrepared
      | Operation::FindIterBuf
      | Operation::IsMatchBuf
      | Operation::StreamWrite => true,
      Operation::New
      | Operation::Prepare
      | Operation::StreamNew
      | Operation::IsMatch
      | Operation::FindIter
      | Operation::FindOverlappingIter
      | Operation::ReplaceAll
      | Operation::PatternCount
      | Operation::ToPrepared
      | Operation::StreamFlush
      | Operation::StreamReset
      | Operation::Free => self.payload.is_empty(),
    };
    if !valid_strings || !valid_payload {
      return Err("invalid request fields for operation".to_owned());
    }
    Ok(())
  }

  fn text(&self) -> Result<&str> {
    self
      .strings
      .first()
      .copied()
      .ok_or_else(|| "missing haystack".to_owned())
  }

  fn patterns(&self) -> Vec<String> {
    self.strings.iter().map(|text| (*text).to_owned()).collect()
  }
}

enum Handle {
  Matcher(AhoCorasick),
  Stream(StreamMatcher),
}

#[derive(Default)]
struct State {
  input: Vec<u8>,
  output: Vec<u8>,
  handles: HashMap<u32, Handle>,
  next_id: u32,
}

thread_local! {
  static STATE: RefCell<State> = RefCell::new(State::default());
}

fn packed_bytes(values: Vec<u32>) -> Vec<u8> {
  let mut bytes = Vec::with_capacity(values.len().saturating_mul(U32_BYTES));
  for value in values {
    bytes.extend_from_slice(&value.to_le_bytes());
  }
  bytes
}

fn match_bytes(matches: Vec<Match>) -> Vec<u8> {
  let mut bytes = Vec::with_capacity(matches.len().saturating_mul(MATCH_BYTES));
  for m in matches {
    bytes.extend_from_slice(&m.pattern.to_le_bytes());
    bytes.extend_from_slice(&m.start.to_le_bytes());
    bytes.extend_from_slice(&m.end.to_le_bytes());
  }
  bytes
}

impl State {
  fn insert(&mut self, handle: Handle) -> Result<Vec<u8>> {
    let id = self
      .next_id
      .checked_add(1)
      .ok_or_else(|| "handle ids exhausted".to_owned())?;
    self.next_id = id;
    self.handles.insert(id, handle);
    Ok(id.to_le_bytes().to_vec())
  }

  fn matcher(&self, id: u32) -> Result<&AhoCorasick> {
    match self.handles.get(&id) {
      Some(Handle::Matcher(matcher)) => Ok(matcher),
      _ => Err("unknown matcher id".to_owned()),
    }
  }

  fn stream(&mut self, id: u32) -> Result<&mut StreamMatcher> {
    match self.handles.get_mut(&id) {
      Some(Handle::Stream(stream)) => Ok(stream),
      _ => Err("unknown stream id".to_owned()),
    }
  }

  fn execute(&mut self, request: &Request<'_>) -> Result<Vec<u8>> {
    match request.operation {
      Operation::New => {
        let matcher = AhoCorasick::new(request.patterns(), request.options)
          .map_err(|error| error.to_string())?;
        self.insert(Handle::Matcher(matcher))
      }
      Operation::Prepare => {
        AhoCorasick::prepare(request.patterns(), request.options)
          .map_err(|error| error.to_string())
      }
      Operation::FromPrepared => {
        let matcher = AhoCorasick::from_prepared(request.payload)
          .map_err(|error| error.to_string())?;
        self.insert(Handle::Matcher(matcher))
      }
      Operation::PatternCount => Ok(
        self
          .matcher(request.id)?
          .pattern_count()
          .to_le_bytes()
          .to_vec(),
      ),
      Operation::IsMatch => self
        .matcher(request.id)?
        .is_match(request.text()?)
        .map(|value| u32::from(value).to_le_bytes().to_vec())
        .map_err(|error| error.to_string()),
      Operation::FindIter => self
        .matcher(request.id)?
        .find_iter_packed(request.text()?)
        .map(packed_bytes)
        .map_err(|error| error.to_string()),
      Operation::FindOverlappingIter => self
        .matcher(request.id)?
        .find_overlapping_iter_packed(request.text()?)
        .map(packed_bytes)
        .map_err(|error| error.to_string()),
      Operation::ReplaceAll => {
        let (haystack, replacements) = request
          .strings
          .split_first()
          .ok_or_else(|| "missing haystack".to_owned())?;
        let replacements: Vec<String> =
          replacements.iter().map(|text| (*text).to_owned()).collect();
        self
          .matcher(request.id)?
          .replace_all(haystack, &replacements)
          .map(String::into_bytes)
          .map_err(|error| error.to_string())
      }
      Operation::FindIterBuf => Ok(packed_bytes(
        self
          .matcher(request.id)?
          .find_iter_packed_buf(request.payload),
      )),
      Operation::IsMatchBuf => Ok(
        u32::from(self.matcher(request.id)?.is_match_buf(request.payload))
          .to_le_bytes()
          .to_vec(),
      ),
      Operation::ToPrepared => self
        .matcher(request.id)?
        .to_prepared()
        .map_err(|error| error.to_string()),
      Operation::StreamNew => {
        let stream = StreamMatcher::new(request.patterns(), request.options)
          .map_err(|error| error.to_string())?;
        self.insert(Handle::Stream(stream))
      }
      Operation::StreamWrite => {
        Ok(match_bytes(self.stream(request.id)?.write(request.payload)))
      }
      Operation::StreamFlush => {
        Ok(match_bytes(self.stream(request.id)?.flush()))
      }
      Operation::StreamReset => {
        self.stream(request.id)?.reset();
        Ok(Vec::new())
      }
      Operation::Free => {
        self
          .handles
          .remove(&request.id)
          .ok_or_else(|| "unknown handle id".to_owned())?;
        Ok(Vec::new())
      }
    }
  }

  fn run(&mut self) -> u32 {
    self.output = Vec::new();
    let input = mem::take(&mut self.input);
    let result =
      Request::parse(&input).and_then(|request| self.execute(&request));
    self.input = input;
    match result {
      Ok(output) => {
        self.output = output;
        0
      }
      Err(error) => {
        self.output = error.into_bytes();
        1
      }
    }
  }
}

/// Allocate initialized input bytes; the offset remains valid until the next allocation.
// Rust 2024 requires an unsafe export attribute; there are no unsafe operations.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn aho_input_alloc(len: u32) -> u32 {
  STATE.with_borrow_mut(|state| {
    let Ok(len) = usize::try_from(len) else {
      return 0;
    };
    if state.input.capacity() < len {
      state
        .input
        .reserve_exact(len.saturating_sub(state.input.len()));
    }
    state.input.resize(len, 0);
    u32::try_from(state.input.as_ptr().addr()).unwrap_or(0)
  })
}

/// Execute the binary request: status zero indicates success, one indicates UTF-8 error output.
// Only the export attribute is unsafe; input stays in an owned initialized allocation.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn aho_run() -> u32 {
  STATE.with_borrow_mut(State::run)
}

/// Return the output offset, valid until the next command executes.
// Only the symbol export uses an unsafe attribute; obtaining a pointer is safe.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn aho_output_ptr() -> u32 {
  STATE.with_borrow(|state| {
    u32::try_from(state.output.as_ptr().addr()).unwrap_or(0)
  })
}

/// Return the number of initialized output bytes.
// Only the symbol export uses an unsafe attribute.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn aho_output_len() -> u32 {
  STATE
    .with_borrow(|state| u32::try_from(state.output.len()).unwrap_or(u32::MAX))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::missing_assert_message)]
mod tests {
  use super::{Request, State, packed_bytes};

  #[derive(Default)]
  struct Command<'a> {
    op: u32,
    id: u32,
    flags: u32,
    strings: &'a [&'a str],
    payload: &'a [u8],
  }

  impl Command<'_> {
    fn encode(&self) -> Vec<u8> {
      let mut bytes = packed_bytes(vec![
        self.op,
        self.id,
        self.flags,
        u32::try_from(self.strings.len()).unwrap(),
      ]);
      for text in self.strings {
        bytes
          .extend_from_slice(&u32::try_from(text.len()).unwrap().to_le_bytes());
        bytes.extend_from_slice(text.as_bytes());
      }
      bytes.extend_from_slice(self.payload);
      bytes
    }
  }

  fn execute(state: &mut State, command: &Command<'_>) -> Vec<u8> {
    state.input = command.encode();
    let ptr = state.input.as_ptr();
    assert_eq!(state.run(), 0, "{}", String::from_utf8_lossy(&state.output));
    assert_eq!(state.input.as_ptr(), ptr);
    state.output.clone()
  }

  fn scalar(bytes: &[u8]) -> u32 {
    u32::from_le_bytes(bytes.try_into().unwrap())
  }

  fn assert_matcher(state: &mut State, handle: u32, prepared: &[u8]) {
    assert_eq!(
      execute(
        state,
        &Command {
          op: 4,
          id: handle,
          ..Command::default()
        }
      ),
      2_u32.to_le_bytes()
    );
    assert_eq!(
      execute(
        state,
        &Command {
          op: 5,
          id: handle,
          strings: &["é😀"],
          ..Command::default()
        }
      ),
      1_u32.to_le_bytes()
    );
    for op in [6, 7] {
      assert_eq!(
        execute(
          state,
          &Command {
            op,
            id: handle,
            strings: &["é😀"],
            ..Command::default()
          }
        ),
        packed_bytes(vec![0, 0, 1, 1, 1, 3])
      );
    }
    assert_eq!(
      execute(
        state,
        &Command {
          op: 8,
          id: handle,
          strings: &["é😀", "a", "b"],
          ..Command::default()
        }
      ),
      b"ab"
    );
    assert_eq!(
      execute(
        state,
        &Command {
          op: 9,
          id: handle,
          payload: "é😀".as_bytes(),
          ..Command::default()
        }
      ),
      packed_bytes(vec![0, 0, 2, 1, 2, 6])
    );
    assert_eq!(
      execute(
        state,
        &Command {
          op: 10,
          id: handle,
          payload: "é".as_bytes(),
          ..Command::default()
        }
      ),
      1_u32.to_le_bytes()
    );
    assert_eq!(
      execute(
        state,
        &Command {
          op: 11,
          id: handle,
          ..Command::default()
        }
      ),
      prepared
    );
  }

  #[test]
  fn binary_protocol_preserves_matching_prepared_data_and_ownership() {
    let mut state = State::default();
    let patterns = ["é", "😀"];
    let id = scalar(&execute(
      &mut state,
      &Command {
        op: 1,
        strings: &patterns,
        ..Command::default()
      },
    ));
    let prepared = execute(
      &mut state,
      &Command {
        op: 2,
        strings: &patterns,
        ..Command::default()
      },
    );
    let restored = scalar(&execute(
      &mut state,
      &Command {
        op: 3,
        payload: &prepared,
        ..Command::default()
      },
    ));
    for handle in [id, restored] {
      assert_matcher(&mut state, handle, &prepared);
    }
    assert!(
      execute(
        &mut state,
        &Command {
          op: 16,
          id,
          ..Command::default()
        }
      )
      .is_empty()
    );
    state.input = Command {
      op: 4,
      id,
      ..Command::default()
    }
    .encode();
    assert_eq!(state.run(), 1);
    assert_eq!(state.output, b"unknown matcher id");
  }

  #[test]
  fn binary_streaming_uses_packed_byte_offsets() {
    let mut state = State::default();
    let id = scalar(&execute(
      &mut state,
      &Command {
        op: 12,
        strings: &["ab"],
        ..Command::default()
      },
    ));
    assert!(
      execute(
        &mut state,
        &Command {
          op: 13,
          id,
          payload: b"a",
          ..Command::default()
        }
      )
      .is_empty()
    );
    assert_eq!(
      execute(
        &mut state,
        &Command {
          op: 13,
          id,
          payload: b"b",
          ..Command::default()
        }
      ),
      packed_bytes(vec![0, 0, 2])
    );
    assert!(
      execute(
        &mut state,
        &Command {
          op: 14,
          id,
          ..Command::default()
        }
      )
      .is_empty()
    );
    assert!(
      execute(
        &mut state,
        &Command {
          op: 15,
          id,
          ..Command::default()
        }
      )
      .is_empty()
    );
    assert_eq!(
      execute(
        &mut state,
        &Command {
          op: 13,
          id,
          payload: b"ab",
          ..Command::default()
        }
      ),
      packed_bytes(vec![0, 0, 2])
    );
  }

  #[test]
  fn binary_requests_reject_invalid_headers_lengths_utf8_and_shapes() {
    let valid = Command {
      op: 1,
      strings: &["é"],
      ..Command::default()
    }
    .encode();
    for len in 0..valid.len() {
      assert!(Request::parse(&valid[..len]).is_err());
    }
    let mut invalid_utf8 = Command {
      op: 1,
      strings: &["a"],
      ..Command::default()
    }
    .encode();
    *invalid_utf8.last_mut().unwrap() = 255;
    assert!(Request::parse(&invalid_utf8).is_err());
    let mut invalid_length = packed_bytes(vec![1, 0, 0, 1, u32::MAX]);
    invalid_length.push(0);
    assert!(Request::parse(&invalid_length).is_err());
    for command in [
      Command {
        op: 99,
        ..Command::default()
      },
      Command {
        op: 1,
        flags: 32,
        ..Command::default()
      },
      Command {
        op: 5,
        ..Command::default()
      },
      Command {
        op: 4,
        strings: &["extra"],
        ..Command::default()
      },
      Command {
        op: 4,
        payload: b"extra",
        ..Command::default()
      },
    ] {
      assert!(Request::parse(&command.encode()).is_err());
    }
  }

  #[test]
  fn binary_flags_match_core_options() {
    let request = Command {
      op: 1,
      flags: 31,
      ..Command::default()
    }
    .encode();
    let options = Request::parse(&request).unwrap().options;
    assert_eq!(options.match_kind, super::MatchKind::LeftmostLongest);
    assert!(options.case_insensitive && options.dfa && options.whole_words);
    assert!(!options.unicode_boundaries);
    assert_eq!(
      Request::parse(
        &Command {
          op: 1,
          ..Command::default()
        }
        .encode()
      )
      .unwrap()
      .options,
      super::Options::default()
    );
  }

  #[test]
  fn binary_errors_preserve_empty_pattern_code_and_index() {
    let mut state = State::default();
    for op in [1, 2, 12] {
      state.input = Command {
        op,
        strings: &["valid", ""],
        ..Command::default()
      }
      .encode();
      assert_eq!(state.run(), 1);
      assert_eq!(
        state.output,
        b"ERR_EMPTY_PATTERN: pattern at index 1 must not be empty"
      );
    }
  }
}
