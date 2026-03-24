/* Main entry point — loads the native NAPI-RS
 * binding and re-exports the public API. */

import { createRequire } from "node:module";

import {
  createApi,
  type NativeBinding,
} from "./core";

const require = createRequire(import.meta.url);
// SAFETY: NAPI-RS auto-generated loader returns the
// native binding object; its shape is validated by
// usage in createApi.
const native =
  require("../index.js") as NativeBinding;

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
