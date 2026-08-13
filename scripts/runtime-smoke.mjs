import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdtemp,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AhoCorasick,
  StreamMatcher,
} from "../dist/index.mjs";

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
const streamMatches = stream.write(
  Buffer.from("dle haystack"),
);
assert.equal(streamMatches.length, 1);
assert.equal(streamMatches[0]?.pattern, 0);
assert.equal(stream.flush().length, 0);

const repositoryRoot = fileURLToPath(
  new URL("../", import.meta.url),
);
const isolatedRoot = await mkdtemp(
  path.join(tmpdir(), "aho-corasick-loader-"),
);

function runLoaderProbe({ env, expectedError }) {
  const loaderPath = path.join(isolatedRoot, "index.cjs");
  const probe = spawnSync(
    process.execPath,
    [
      "-e",
      "try { const binding = require(process.argv[1]); if (typeof binding.AhoCorasick !== 'function') process.exit(2) } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1) }",
      loaderPath,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, ...env },
    },
  );
  if (expectedError) {
    assert.notEqual(probe.status, 0);
    assert.match(probe.stderr, expectedError);
    return;
  }
  assert.equal(probe.status, 0, probe.stderr);
}

try {
  await copyFile(
    path.join(repositoryRoot, "index.cjs"),
    path.join(isolatedRoot, "index.cjs"),
  );
  for (const fileName of await readdir(repositoryRoot)) {
    if (fileName.endsWith(".node")) {
      await copyFile(
        path.join(repositoryRoot, fileName),
        path.join(isolatedRoot, fileName),
      );
    }
  }

  runLoaderProbe({ env: { NAPI_RS_FORCE_WASI: "false" } });
  runLoaderProbe({ env: { NAPI_RS_FORCE_WASI: "true" } });
  runLoaderProbe({
    env: { NAPI_RS_FORCE_WASI: "error" },
    expectedError:
      /WASI binding not found and NAPI_RS_FORCE_WASI is set to error/,
  });
  runLoaderProbe({
    env: { NAPI_RS_WASI_FLAVOR: "unsupported" },
    expectedError: /Unsupported WASI flavor "unsupported"/,
  });
  runLoaderProbe({
    env: { NAPI_RS_WASI_FLAVOR: "wasm32-wasi" },
    expectedError:
      /WASI binding for flavor "wasm32-wasi" not found/,
  });
} finally {
  await rm(isolatedRoot, { force: true, recursive: true });
}

console.log("runtime smoke ok");
