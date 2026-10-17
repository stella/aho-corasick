import { expect, test } from "bun:test";
import fc from "fast-check";
import { createRequire } from "node:module";

import type {
  Match,
  NativeBinding,
  Options,
} from "../src/core";
import {
  AhoCorasick,
  EmptyPatternError,
  StreamMatcher,
} from "../src/index";

const scalar = fc
  .oneof(
    fc.integer({ min: 0, max: 0xd7ff }),
    fc.integer({ min: 0xe000, max: 0x10ffff }),
  )
  .map((value) => String.fromCodePoint(value));
const unicode = fc
  .array(scalar, { maxLength: 24 })
  .map((chars) => chars.join(""));

const boundaries = (text: string) => {
  const result = [0];
  let offset = 0;
  for (const char of text) {
    offset += char.length;
    result.push(offset);
  }
  return result;
};

// Enumerate literal matches independently of either engine binding.
const reference = (
  patterns: string[],
  text: string,
  longest: boolean,
) => {
  const all: Match[] = [];
  for (const start of boundaries(text)) {
    for (const [pattern, needle] of patterns.entries()) {
      if (
        patterns.indexOf(needle) !== pattern ||
        !text.startsWith(needle, start)
      )
        continue;
      all.push({
        pattern,
        start,
        end: start + needle.length,
        text: needle,
      });
    }
  }
  const selected: Match[] = [];
  let end = 0;
  for (const start of boundaries(text)) {
    if (start < end) continue;
    const candidates = all.filter(
      (match) => match.start === start,
    );
    candidates.sort(
      (a, b) =>
        (longest ? b.end - a.end : 0) ||
        a.pattern - b.pattern,
    );
    const match = candidates.at(0);
    if (!match) continue;
    selected.push(match);
    end = match.end;
  }
  return { all, selected };
};

test("nonempty patterns match a Unicode scalar reference", () => {
  fc.assert(
    fc.property(
      unicode,
      fc.array(
        fc
          .array(scalar, { minLength: 1, maxLength: 12 })
          .map((chars) => chars.join("")),
        { minLength: 1, maxLength: 4 },
      ),
      fc.boolean(),
      (text, generated, longest) => {
        const chars = [...text];
        const patterns = [
          ...generated,
          ...chars.slice(0, 3),
        ];
        if (chars.length > 0)
          patterns.push(chars.slice(0, 2).join(""));
        const options: Options = {
          matchKind: longest
            ? "leftmost-longest"
            : "leftmost-first",
        };
        const expected = reference(patterns, text, longest);
        const replacements = patterns.map(
          (_, index) => `[${index}]`,
        );
        let replaced = "";
        let last = 0;
        for (const match of expected.selected) {
          replaced +=
            text.slice(last, match.start) +
            replacements[match.pattern];
          last = match.end;
        }
        replaced += text.slice(last);
        const direct = new AhoCorasick(patterns, options);
        const prepared = AhoCorasick.fromPrepared(
          AhoCorasick.prepare(patterns, options),
        );
        for (const matcher of [direct, prepared]) {
          expect(matcher.findIter(text)).toEqual(
            expected.selected,
          );
          const sort = (matches: Match[]) =>
            matches.toSorted(
              (a, b) =>
                a.end - b.end || a.pattern - b.pattern,
            );
          expect(
            sort(matcher.findOverlappingIter(text)),
          ).toEqual(sort(expected.all));
          expect(matcher.isMatch(text)).toBe(
            expected.all.length > 0,
          );
          expect(
            matcher.replaceAll(text, replacements),
          ).toBe(replaced);
          for (const match of matcher.findOverlappingIter(
            text,
          )) {
            expect(boundaries(text)).toContain(match.start);
            expect(boundaries(text)).toContain(match.end);
          }
        }
      },
    ),
    { numRuns: 200 },
  );
});

test("empty patterns throw the documented typed error before construction", () => {
  for (const wholeWords of [false, true]) {
    for (const patterns of [[""], ["valid", ""]]) {
      for (const construct of [
        () => new AhoCorasick(patterns, { wholeWords }),
        () => AhoCorasick.prepare(patterns, { wholeWords }),
        () => new StreamMatcher(patterns, { wholeWords }),
      ]) {
        expect(construct).toThrow(EmptyPatternError);
        try {
          construct();
        } catch (error) {
          if (!(error instanceof EmptyPatternError))
            throw error;
          expect(error).toBeInstanceOf(RangeError);
          expect(error.code).toBe("ERR_EMPTY_PATTERN");
          expect(error.patternIndex).toBe(
            patterns.length - 1,
          );
        }
      }
    }
  }
  expect(
    () => new AhoCorasick([{ pattern: "", name: "empty" }]),
  ).toThrow(EmptyPatternError);
  expect(new AhoCorasick([]).findIter("😀é中")).toEqual([]);
});

test("direct NAPI bindings reject empty patterns with InvalidArg", () => {
  const require = createRequire(import.meta.url);
  // SAFETY: generated loader exposes the binding contract exercised below.
  const native = require("../index.cjs") as NativeBinding;
  for (const construct of [
    () =>
      new native.AhoCorasick(["valid", ""], {
        wholeWords: true,
      }),
    () => new native.StreamMatcher(["valid", ""]),
    () => native.prepareAhoCorasick(["valid", ""]),
  ]) {
    expect(construct).toThrow(
      "ERR_EMPTY_PATTERN: pattern at index 1 must not be empty",
    );
    try {
      construct();
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error))
        throw error;
      expect(error.code).toBe("InvalidArg");
    }
  }
});
