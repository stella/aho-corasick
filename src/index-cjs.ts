/* CommonJS entry point — bundles the same public
 * JS wrapper API as the ESM build, but binds it to
 * the napi-rs CommonJS loader for require() users. */

import { initBinding, type NativeBinding } from "./core";
import { AhoCorasick, StreamMatcher } from "./core";

// eslint-disable-next-line unicorn/prefer-module
const native = require("../index.js") as NativeBinding;

initBinding(native);

export { AhoCorasick, StreamMatcher };
