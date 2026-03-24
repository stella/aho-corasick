/* WASM/browser entry point — loads the WASI module
 * instead of the native .node binary. Same API as
 * the main entry point. */

import { createRequire } from "node:module";

import {
  createApi,
  type NativeBinding,
} from "./core";

const require = createRequire(import.meta.url);
// SAFETY: NAPI-RS auto-generated WASI loader
// returns the same binding shape as the native one.
const native =
  require("../aho-corasick.wasi.cjs") as NativeBinding;

const { AhoCorasick, StreamMatcher } =
  createApi(native);

export { AhoCorasick, StreamMatcher };

export type {
  ByteMatch,
  Match,
  MatchKind,
  NativeBinding,
  Options,
  PatternEntry,
} from "./core";
