import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import {
  AhoCorasick,
  EmptyPatternError,
  init,
  initSync,
  StreamMatcher,
} from "../wasm/dist/single-thread.mjs";

// Node provides the WASI API used by the existing threaded NAPI loader.
const require = createRequire(import.meta.url);
const threaded = require("../aho-corasick.wasi.cjs");
class ThreadedMatcher extends AhoCorasick {
  static getBinding() {
    return threaded;
  }
}
class ThreadedStream extends StreamMatcher {
  static getBinding() {
    return threaded;
  }
}
const bytes = readFileSync(
  new URL("../aho-corasick.single-thread.wasm", import.meta.url),
);
initSync(bytes);
try {
  for (const { text, replacement, expected } of [
    {
      text: "\uFEFFfoo",
      replacement: "x",
      expected: "\uFEFFx",
    },
    {
      text: "foo",
      replacement: "\uFEFFx",
      expected: "\uFEFFx",
    },
    {
      text: "\uFEFFabsent",
      replacement: "x",
      expected: "\uFEFFabsent",
    },
  ]) {
    const single = new AhoCorasick(["foo"]);
    const original = new ThreadedMatcher(["foo"]);
    assert.equal(original.replaceAll(text, [replacement]), expected);
    assert.equal(single.replaceAll(text, [replacement]), expected);
  }
  for (const construct of [
    () => new AhoCorasick([""], { wholeWords: true }),
    () => new ThreadedMatcher([""], { wholeWords: true }),
    () => AhoCorasick.prepare([""]),
    () => ThreadedMatcher.prepare([""]),
    () => new StreamMatcher([""]),
    () => new ThreadedStream([""]),
  ]) {
    assert.throws(construct, EmptyPatternError);
  }
  const corpus = [
    { patterns: ["he", "she", "his"], text: "ushers" },
    {
      patterns: ["foo", "foobar", "bar", "foo"],
      text: "foobar foo",
    },
    {
      patterns: ["😀", "é", "中", "İ"],
      text: "😀é中 İ i",
    },
    { patterns: [], text: "anything" },
    { patterns: ["absent"], text: "" },
    {
      patterns: ["\ud800", "\udfff"],
      text: "a\ud800b\udfff",
    },
  ];
  for (const matchKind of ["leftmost-first", "leftmost-longest"]) {
    for (const caseInsensitive of [false, true]) {
      for (const wholeWords of [false, true]) {
        for (const unicodeBoundaries of [false, true]) {
          for (const dfa of [false, true]) {
            const options = {
              matchKind,
              caseInsensitive,
              wholeWords,
              unicodeBoundaries,
              dfa,
            };
            for (const { patterns, text } of corpus) {
              const single = new AhoCorasick(patterns, options);
              const original = new ThreadedMatcher(patterns, options);
              assert.equal(single.patternCount, original.patternCount);
              assert.deepEqual(single.findIter(text), original.findIter(text));
              assert.deepEqual(
                single.findOverlappingIter(text),
                original.findOverlappingIter(text),
              );
              assert.equal(single.isMatch(text), original.isMatch(text));
              const replacements = patterns.map((_, index) => `[${index}]`);
              assert.equal(
                single.replaceAll(text, replacements),
                original.replaceAll(text, replacements),
              );
              const encoded = new TextEncoder().encode(text);
              assert.deepEqual(
                single.findIterBuf(encoded),
                original.findIterBuf(encoded),
              );
              assert.equal(
                single.isMatchBuf(encoded),
                original.isMatchBuf(encoded),
              );
              assert.deepEqual(
                AhoCorasick.fromPrepared(original.toPrepared()).findIter(text),
                original.findIter(text),
              );
              assert.deepEqual(
                ThreadedMatcher.fromPrepared(single.toPrepared()).findIter(
                  text,
                ),
                single.findIter(text),
              );
            }
          }
        }
      }
    }
  }
  const named = [{ pattern: "foo", name: "first" }];
  assert.deepEqual(
    new AhoCorasick(named).findIter("foo"),
    new ThreadedMatcher(named).findIter("foo"),
  );
  const stream = new StreamMatcher(["foobar"]);
  const originalStream = new ThreadedStream(["foobar"]);
  for (const chunk of ["xxfo", "obarxx"]) {
    const encoded = new TextEncoder().encode(chunk);
    assert.deepEqual(stream.write(encoded), originalStream.write(encoded));
  }
  assert.deepEqual(stream.flush(), originalStream.flush());
  stream.reset();
  originalStream.reset();
  assert.deepEqual(
    stream.write(new TextEncoder().encode("foobar")),
    originalStream.write(new TextEncoder().encode("foobar")),
  );
  // Reinitializing the single entry never rebinds constructors of the threaded entry.
  await init(bytes);
  assert.equal(new ThreadedMatcher(["old"]).isMatch("old"), true);
  assert.equal(new AhoCorasick(["new"]).isMatch("new"), true);
} finally {
  const dispose = Reflect.get(threaded, Symbol.for("napi.rs.wasi.dispose"));
  if (typeof dispose === "function") await dispose();
}
