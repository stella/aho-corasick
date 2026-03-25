/* Browser/WASM entry point — loads the WASM binding
 * from the sub-package and re-exports the public API
 * through the shared core. */

import native from "@stll/aho-corasick-wasm32-wasi";
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
