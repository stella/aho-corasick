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

/** @param {{ browser: boolean }} options */
const cleanupHandshakeFixture = ({ browser }) => `
let __emnapiWasmEnvCleanupPrepared = false
let __emnapiWasmEnvCleanupPreparing = false
let __finishParkedWasmEnvCleanup
let finishCalls = 0
let schedulingFails = true
let workIsLive = true
const __napiInstance = { exports: {
  napi_prepare_wasm_env_cleanup_begin: () => true,
  napi_prepare_wasm_env_cleanup_finish: () => { finishCalls += 1 },
  napi_wasm_runtime_work_pending: () => workIsLive,
} }
const __createWasmRuntimePollPace = () => ({})
const __yieldWasmRuntimePollTurn = () => new Promise((resolve) => {
  if (schedulingFails) throw new Error("scheduler failed")
  resolve()
})
${browser === true ? "" : "const __abortWasiDisposalIfThreadCrashed = () => {}"}
function __prepareWasmEnvCleanupWithTurns() {
  if (__emnapiWasmEnvCleanupPrepared || __emnapiWasmEnvCleanupPreparing) {
    return
  }
  const exports = __napiInstance?.exports
  const begin = exports?.napi_prepare_wasm_env_cleanup_begin
  const finish = exports?.napi_prepare_wasm_env_cleanup_finish
  const workPending = exports?.napi_wasm_runtime_work_pending
  __emnapiWasmEnvCleanupPreparing = true
  const live = begin()
  const finishCleanup = () => {
    __finishParkedWasmEnvCleanup = undefined
    finish()
    __emnapiWasmEnvCleanupPreparing = false
    __emnapiWasmEnvCleanupPrepared = true
  }
  if (!live || typeof workPending !== 'function') {
    finishCleanup()
    return
  }
  __finishParkedWasmEnvCleanup = finishCleanup
  ${
    browser === true
      ? ""
      : `const finishCleanupUnlessCrashed = () => {
    __abortWasiDisposalIfThreadCrashed()
    finishCleanup()
  }`
  }
  return (async () => {
    const pace = __createWasmRuntimePollPace()
    for (;;) {
      await __yieldWasmRuntimePollTurn(pace)
      ${browser === true ? "" : "__abortWasiDisposalIfThreadCrashed()"}
      if (!workPending()) return
    }
  })().then(${browser === true ? "finishCleanup, finishCleanup" : "finishCleanupUnlessCrashed, finishCleanupUnlessCrashed"})
}
return {
  dispose: __prepareWasmEnvCleanupWithTurns,
  finishCalls: () => finishCalls,
  allowScheduling: () => { schedulingFails = false },
  finishWork: () => { workIsLive = false },
}
`;

for (const browser of [false, true]) {
  test(`a ${browser === true ? "browser" : "Node"} loader does not finish live work after a scheduling failure`, async () => {
    const fixture = cleanupHandshakeFixture({ browser });
    const normalized = normalizeGeneratedLoader(fixture);
    // oxlint-disable-next-line typescript/no-implied-eval -- Executes the generated-loader fixture after normalization.
    const loader = Function(normalized)();

    const failedDisposal = loader.dispose();
    let schedulingError;
    try {
      await Promise.resolve(failedDisposal);
    } catch (error) {
      schedulingError = error;
    }
    expect(schedulingError).toHaveProperty(
      "message",
      "scheduler failed",
    );
    expect(loader.finishCalls()).toBe(0);

    loader.allowScheduling();
    loader.finishWork();
    await Promise.resolve(loader.dispose());
    expect(loader.finishCalls()).toBe(1);
  });
}
