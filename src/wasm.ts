/* Browser/WASM package entry point -- loads the WASM
 * binding from the generated browser glue and
 * re-exports the public API through the shared core. */

import native from "../aho-corasick.wasi-browser.js";
import { initBinding, type NativeBinding } from "./core";

initBinding(native as unknown as NativeBinding);

export { AhoCorasick, StreamMatcher } from "./core";

export type {
  ByteMatch,
  Match,
  MatchKind,
  NativeBinding,
  Options,
  PatternEntry,
} from "./core";
