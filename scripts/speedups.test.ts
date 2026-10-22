import { expect, test } from "bun:test";

import { speedupRows } from "../__bench__/speedups";

test("speedup rows preserve competitor order and formatting", () => {
  expect(
    speedupRows({
      names: ["baseline", "first", "second"],
      times: [2, 4, 1],
    }),
  ).toEqual(["  vs first: 2.0x", "  vs second: 0.5x"]);
});

test("missing timings fail explicitly for every position", () => {
  const names = ["baseline", "first", "second"];
  for (let count = 0; count < names.length; count++) {
    expect(() =>
      speedupRows({
        names,
        times: Array.from({ length: count }, () => 1),
      }),
    ).toThrow(
      count === 0
        ? "Missing baseline timing"
        : `Missing timing for ${names.at(count)}`,
    );
  }
  expect(speedupRows({ names: ["baseline"], times: [1] })).toEqual([]);
});
