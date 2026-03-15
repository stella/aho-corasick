import { describe, expect, test } from "bun:test";

import {
  AhoCorasick,
  StreamMatcher,
} from "../index";

describe("AhoCorasick", () => {
  test("basic matching", () => {
    const ac = new AhoCorasick(["he", "she", "his"]);
    expect(ac.patternCount).toBe(3);
    expect(ac.isMatch("ushers")).toBe(true);
    expect(ac.isMatch("xyz")).toBe(false);
  });

  test("findIter returns correct matches", () => {
    const ac = new AhoCorasick(["foo", "bar"]);
    const matches = ac.findIter("foo bar foo");

    expect(matches).toEqual([
      { pattern: 0, start: 0, end: 3 },
      { pattern: 1, start: 4, end: 7 },
      { pattern: 0, start: 8, end: 11 },
    ]);
  });

  test("leftmost-longest semantics", () => {
    const ac = new AhoCorasick(["abc", "abcd"], {
      matchKind: "leftmost-longest",
    });
    const matches = ac.findIter("abcd");

    expect(matches).toHaveLength(1);
    expect(matches[0]!.pattern).toBe(1);
    expect(matches[0]!.end).toBe(4);
  });

  test("leftmost-first semantics", () => {
    const ac = new AhoCorasick(["abc", "abcd"], {
      matchKind: "leftmost-first",
    });
    const matches = ac.findIter("abcd");

    expect(matches).toHaveLength(1);
    // "abc" was added first, so it wins
    expect(matches[0]!.pattern).toBe(0);
    expect(matches[0]!.end).toBe(3);
  });

  test("case-insensitive matching", () => {
    const ac = new AhoCorasick(["hello"], {
      caseInsensitive: true,
    });

    expect(ac.isMatch("HELLO WORLD")).toBe(true);

    const matches = ac.findIter("Hello hElLo");
    expect(matches).toHaveLength(2);
  });

  test("replaceAll", () => {
    const ac = new AhoCorasick(["foo", "bar"]);
    const result = ac.replaceAll(
      "foo bar baz",
      ["FOO", "BAR"],
    );
    expect(result).toBe("FOO BAR baz");
  });

  test(
    "replaceAll throws on wrong replacement count",
    () => {
      const ac = new AhoCorasick(["a", "b"]);
      expect(() =>
        ac.replaceAll("ab", ["x"]),
      ).toThrow();
    },
  );

  test(
    "handles unicode — character offsets, not bytes",
    () => {
      // "café" = 4 chars but 5 bytes in UTF-8
      const ac = new AhoCorasick(["café", "naïve"]);
      const text = "a café and naïve";
      const matches = ac.findIter(text);

      expect(matches).toHaveLength(2);
      // "café" starts at char 2
      expect(matches[0]!.start).toBe(2);
      expect(matches[0]!.end).toBe(6);
      // Check the substring matches
      const m0 = text.slice(
        matches[0]!.start,
        matches[0]!.end,
      );
      expect(m0).toBe("café");

      const m1 = text.slice(
        matches[1]!.start,
        matches[1]!.end,
      );
      expect(m1).toBe("naïve");
    },
  );

  test("findIterBuf returns byte offsets", () => {
    const ac = new AhoCorasick(["foo"]);
    const buf = Buffer.from("hello foo world");
    const matches = ac.findIterBuf(buf);

    expect(matches).toHaveLength(1);
    expect(matches[0]!.start).toBe(6);
    expect(matches[0]!.end).toBe(9);
  });

  test("empty patterns array", () => {
    const ac = new AhoCorasick([]);
    expect(ac.patternCount).toBe(0);
    expect(ac.isMatch("anything")).toBe(false);
    expect(ac.findIter("anything")).toEqual([]);
  });

  test("dfa option", () => {
    const ac = new AhoCorasick(["test"], {
      dfa: true,
    });
    expect(ac.isMatch("a test")).toBe(true);
  });
});

describe("StreamMatcher", () => {
  test("finds matches across chunks", () => {
    const sm = new StreamMatcher(["hello", "world"]);

    // "hello" spans chunks
    const m1 = sm.write(Buffer.from("hel"));
    const m2 = sm.write(Buffer.from("lo world"));
    sm.flush();

    const all = [...m1, ...m2];
    expect(
      all.some((m) => m.pattern === 0),
    ).toBe(true);
    expect(
      all.some((m) => m.pattern === 1),
    ).toBe(true);
  });

  test("reset clears state", () => {
    const sm = new StreamMatcher(["abc"]);
    sm.write(Buffer.from("abc"));
    sm.reset();

    const matches = sm.write(Buffer.from("abc"));
    expect(matches).toHaveLength(1);
    expect(matches[0]!.start).toBe(0);
  });

  test(
    "single-byte patterns need no overlap",
    () => {
      const sm = new StreamMatcher(["a", "b"]);
      const m1 = sm.write(Buffer.from("xa"));
      const m2 = sm.write(Buffer.from("bx"));
      sm.flush();

      const all = [...m1, ...m2];
      expect(all).toHaveLength(2);
    },
  );
});
