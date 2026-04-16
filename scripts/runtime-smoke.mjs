import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import { AhoCorasick, StreamMatcher } from "../dist/index.mjs";

const haystack = "foo bar baz";
const matcher = new AhoCorasick(["foo", "bar", "baz"]);
const matches = matcher.findIter(haystack);

assert.equal(matcher.patternCount, 3);
assert.equal(matcher.isMatch(haystack), true);
assert.deepEqual(
  matches.map((match) => match.text),
  ["foo", "bar", "baz"],
);
assert.equal(
  matcher.replaceAll(haystack, ["FOO", "BAR", "BAZ"]),
  "FOO BAR BAZ",
);

const stream = new StreamMatcher(["needle"]);
assert.equal(stream.write(Buffer.from("nee")).length, 0);
const streamMatches = stream.write(Buffer.from("dle haystack"));
assert.equal(streamMatches.length, 1);
assert.equal(streamMatches[0]?.pattern, 0);
assert.equal(stream.flush().length, 0);

console.log("runtime smoke ok");
