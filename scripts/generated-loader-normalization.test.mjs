import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { normalizeGeneratedLoader } from "./generated-loader-normalization.mjs";

const directive =
  /(?:eslint-disable|oxlint-disable|@ts-(?:nocheck|ignore|expect-error)|prettier-ignore)/u;

test("removes every generated suppression directive form", () => {
  const fixture = [
    "// eslint-disable",
    "// eslint-disable-next-line no-console -- generated output",
    "/* eslint-disable no-undef */",
    "/* eslint-disable-next-line no-console -- generated output */",
    "// oxlint-disable",
    "// oxlint-disable-next-line no-console -- generated output",
    "/* oxlint-disable no-undef */",
    "/* oxlint-disable-next-line no-console -- generated output */",
    "// @ts-nocheck",
    "/* @ts-ignore */",
    "// @ts-expect-error -- generated output",
    "/* prettier-ignore */",
    "const generated = true;   ",
  ].join("\n");

  const normalized = normalizeGeneratedLoader(fixture);
  expect(normalized).toBe("const generated = true;");
  expect(normalized).not.toMatch(directive);
});

test("real generated loaders contain no suppression directives", () => {
  const loaders = [
    "../index.cjs",
    "../index.d.cts",
    "../aho-corasick.wasi.cjs",
    "../aho-corasick.wasi.d.cts",
    "../aho-corasick.wasi-browser.js",
    "../wasi-worker.mjs",
    "../wasi-worker-browser.mjs",
    "../npm/wasm32-wasi/aho-corasick.wasi.cjs",
    "../npm/wasm32-wasi/aho-corasick.wasi.d.cts",
    "../npm/wasm32-wasi/aho-corasick.wasi-browser.js",
    "../npm/wasm32-wasi/wasi-worker.mjs",
    "../npm/wasm32-wasi/wasi-worker-browser.mjs",
  ];

  for (const loader of loaders) {
    const content = readFileSync(
      new URL(loader, import.meta.url),
      "utf8",
    );
    expect(content).not.toMatch(directive);
  }
});
