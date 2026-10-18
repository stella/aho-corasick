/* Main entry point — loads the native NAPI-RS
 * binding and re-exports the public API. */

import native from "../index.cjs";
import { initBinding } from "./core";

initBinding(native);

export {
  AhoCorasick,
  StreamMatcher,
  EmptyPatternError,
} from "./core";

export type {
  ByteMatch,
  Match,
  MatchKind,
  NativeBinding,
  Options,
  PatternEntry,
  PreparedAhoCorasick,
} from "./core";
