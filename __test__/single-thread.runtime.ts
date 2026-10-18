import { expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";

import {
  AhoCorasick,
  init,
  initSync,
} from "../src/single-thread";
import { createSingleThreadBinding } from "../src/single-thread-binding";

const bytes = readFileSync(
  new URL(
    "../aho-corasick.single-thread.wasm",
    import.meta.url,
  ),
);

test("import defers initialization and artifact has no imports or shared memory", () => {
  expect(() => new AhoCorasick(["a"])).toThrow(
    "Call init()",
  );
  const module = new WebAssembly.Module(bytes);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module);
  const memory = instance.exports.memory;
  expect(memory).toBeInstanceOf(WebAssembly.Memory);
  if (!(memory instanceof WebAssembly.Memory))
    throw new Error("Missing WASM memory");
  expect(memory.buffer).toBeInstanceOf(ArrayBuffer);
  initSync(bytes);
  expect(new AhoCorasick(["😀"]).findIter("a😀b")).toEqual([
    { pattern: 0, start: 1, end: 3, text: "😀" },
  ]);
});

test("both initializers honor Buffer and Uint8Array subarray bounds", async () => {
  const allocation = Buffer.alloc(
    bytes.byteLength + 64,
    0xa5,
  );
  allocation.set(bytes, 32);
  const buffer = allocation.subarray(
    32,
    32 + bytes.byteLength,
  );
  const typed = new Uint8Array(
    allocation.buffer,
    allocation.byteOffset + 32,
    bytes.byteLength,
  );
  expect(buffer.byteOffset).toBeGreaterThan(
    allocation.byteOffset,
  );
  for (const view of [buffer, typed]) {
    expect(WebAssembly.validate(view)).toBe(true);
    initSync(view);
    expect(
      new AhoCorasick(["valid"]).isMatch("valid"),
    ).toBe(true);
    await init(view);
    expect(new AhoCorasick(["😀"]).findIter("a😀")).toEqual(
      [{ pattern: 0, start: 1, end: 3, text: "😀" }],
    );
  }
});

test("both initializers accept an ArrayBuffer from another realm", async () => {
  const foreign: unknown = runInNewContext(
    "const view = new Uint8Array(source.length); view.set(source); view.buffer",
    { source: bytes },
  );
  const isArrayBuffer = (
    value: unknown,
  ): value is ArrayBuffer =>
    Object.prototype.toString.call(value) ===
    "[object ArrayBuffer]";
  if (!isArrayBuffer(foreign))
    throw new Error("Invalid realm fixture");
  expect(foreign instanceof ArrayBuffer).toBe(false);
  initSync(foreign);
  expect(new AhoCorasick(["realm"]).isMatch("realm")).toBe(
    true,
  );
  await init(foreign);
  expect(new AhoCorasick(["😀"]).findIter("a😀")).toEqual([
    { pattern: 0, start: 1, end: 3, text: "😀" },
  ]);
});

test("both initializers accept typed arrays and DataViews from another realm", async () => {
  const foreign: unknown = runInNewContext(
    `
    const allocation = new Uint8Array(source.length + 64);
    allocation.fill(0xa5);
    allocation.set(source, 32);
    [new Uint8Array(allocation.buffer, 32, source.length),
     new DataView(allocation.buffer, 32, source.length)];
  `,
    { source: bytes },
  );
  if (!Array.isArray(foreign))
    throw new Error("Invalid realm fixture");
  for (const value of foreign) {
    if (!ArrayBuffer.isView(value))
      throw new Error("Invalid view fixture");
    expect(value instanceof Uint8Array).toBe(false);
    expect(value instanceof DataView).toBe(false);
    initSync(value);
    expect(new AhoCorasick(["view"]).isMatch("view")).toBe(
      true,
    );
    await init(value);
    expect(new AhoCorasick(["😀"]).isMatch("😀")).toBe(
      true,
    );
  }
});

// VM contexts do not expose Web API constructors. Reflect.construct preserves
// genuine internal slots while giving the object a prototype from that realm.
const foreignWebObject = (
  Host: unknown,
  args: unknown[],
): unknown =>
  runInNewContext(
    `
    function Foreign(...args) { return Reflect.construct(Host, args, new.target); }
    Object.defineProperties(Foreign.prototype, Object.getOwnPropertyDescriptors(Host.prototype));
    new Foreign(...args);
  `,
    { Host, args },
  );

const isURL = (value: unknown): value is URL =>
  Object.prototype.toString.call(value) === "[object URL]";
const isRequest = (value: unknown): value is Request =>
  Object.prototype.toString.call(value) ===
  "[object Request]";
const isResponse = (value: unknown): value is Response =>
  Object.prototype.toString.call(value) ===
  "[object Response]";

test("a URL from another realm is passed to fetch", async () => {
  const foreign = foreignWebObject(URL, [
    "https://extension.invalid/realm.wasm",
  ]);
  if (!isURL(foreign))
    throw new Error("Invalid URL fixture");
  expect(foreign instanceof URL).toBe(false);
  expect(foreign.href).toBe(
    "https://extension.invalid/realm.wasm",
  );
  const requests: unknown[] = [];
  const fetcher = spyOn(
    globalThis,
    "fetch",
  ).mockImplementation(async (source) => {
    requests.push(source);
    return new Response(bytes);
  });
  try {
    await init(foreign);
    expect(requests).toEqual([foreign]);
    expect(new AhoCorasick(["url"]).isMatch("url")).toBe(
      true,
    );
  } finally {
    fetcher.mockRestore();
  }
});

test("a Request from another realm is passed to fetch", async () => {
  const foreign = foreignWebObject(Request, [
    "https://extension.invalid/request.wasm",
  ]);
  if (!isRequest(foreign))
    throw new Error("Invalid Request fixture");
  expect(foreign instanceof Request).toBe(false);
  expect(foreign.url).toBe(
    "https://extension.invalid/request.wasm",
  );
  const requests: unknown[] = [];
  const fetcher = spyOn(
    globalThis,
    "fetch",
  ).mockImplementation(async (source) => {
    requests.push(source);
    return new Response(bytes);
  });
  try {
    await init(foreign);
    expect(requests).toEqual([foreign]);
    expect(
      new AhoCorasick(["request"]).isMatch("request"),
    ).toBe(true);
  } finally {
    fetcher.mockRestore();
  }
});

test("a Response from another realm supplies bytes without fetching", async () => {
  const foreign = foreignWebObject(Response, [bytes]);
  if (!isResponse(foreign))
    throw new Error("Invalid Response fixture");
  expect(foreign instanceof Response).toBe(false);
  expect(foreign.ok).toBe(true);
  const fetcher = spyOn(
    globalThis,
    "fetch",
  ).mockImplementation(async () => {
    throw new Error("Unexpected fetch");
  });
  try {
    await init(foreign);
    expect(foreign.bodyUsed).toBe(true);
    expect(
      new AhoCorasick(["response"]).isMatch("response"),
    ).toBe(true);
    const failure = foreignWebObject(Response, [
      "missing",
      { status: 404 },
    ]);
    if (!isResponse(failure))
      throw new Error("Invalid Response fixture");
    await init(failure).then(
      () => {
        throw new Error("Expected HTTP rejection");
      },
      (error) => {
        if (!(error instanceof Error)) throw error;
        expect(error.message).toContain("404");
      },
    );
    expect(
      new AhoCorasick(["still ready"]).isMatch(
        "still ready",
      ),
    ).toBe(true);
  } finally {
    fetcher.mockRestore();
  }
});

test("100 MiB inputs use one bounded binary request without JSON or numeric-array expansion", () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(bytes),
  );
  const { memory, aho_input_alloc: allocate } =
    instance.exports;
  if (
    !(memory instanceof WebAssembly.Memory) ||
    typeof allocate !== "function"
  )
    throw new Error("Invalid WASM fixture");
  let maxRequest = 0;
  const binding = createSingleThreadBinding({
    ...instance.exports,
    aho_input_alloc: (length: number) => {
      maxRequest = Math.max(maxRequest, length);
      return allocate(length);
    },
  });
  const size = 100 * 1024 * 1024;
  const input = new Uint8Array(size);
  const initialMemory = memory.buffer.byteLength;
  const stringify = JSON.stringify;
  const from = Array.from;
  const results: unknown[] = [];
  let invalidPreparedRejected = false;
  try {
    JSON.stringify = () => {
      throw new Error("Transport used JSON");
    };
    Array.from = () => {
      throw new Error("Transport expanded a numeric array");
    };
    const matcher = new binding.AhoCorasick([
      "needle",
      "é😀",
    ]);
    results.push(matcher.isMatchBuf(input));
    results.push(matcher._findIterPackedBuf(input).length);
    const stream = new binding.StreamMatcher(["needle"]);
    results.push(stream.write(input).length);
    results.push(stream.flush().length);
    const text = "x".repeat(size);
    results.push(matcher.isMatch(text));
    results.push(matcher._findIterPacked(text).length);
    results.push(
      matcher._findOverlappingIterPacked(text).length,
    );
    const replacement = "r".repeat(1024 * 1024);
    results.push(
      matcher.replaceAll("needle", [replacement, "other"])
        .length,
    );
    const prepared = binding.prepareAhoCorasick(["é😀"]);
    results.push(
      binding
        .ahoCorasickFromPrepared(prepared)
        .isMatch("é😀"),
    );
    try {
      binding.ahoCorasickFromPrepared(input);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("prepared automaton")
      )
        throw error;
      invalidPreparedRejected = true;
    }
  } finally {
    JSON.stringify = stringify;
    Array.from = from;
  }
  expect(results).toEqual([
    false,
    0,
    0,
    0,
    false,
    0,
    0,
    1024 * 1024,
    true,
  ]);
  expect(invalidPreparedRejected).toBe(true);
  // 16-byte header plus one UTF-8 string length; bytes need only the header.
  expect(maxRequest).toBeLessThanOrEqual(size + 20);
  // Includes input allocation/reallocation and the core streaming overlap copy.
  expect(
    memory.buffer.byteLength - initialMemory,
  ).toBeLessThanOrEqual(3 * size + 64 * 1024 * 1024);
}, 60_000);

test("packed inline import, init and match work without SAB, Worker, network or file fetching", () => {
  const entry = new URL(
    "../wasm/dist/single-thread-inline.mjs",
    import.meta.url,
  ).href;
  const source = `
    Reflect.deleteProperty(globalThis, 'SharedArrayBuffer');
    Reflect.deleteProperty(globalThis, 'Worker');
    globalThis.fetch = () => { throw new Error('unexpected fetch'); };
    Bun.file = () => { throw new Error('unexpected file fetch'); };
    const Memory = WebAssembly.Memory;
    WebAssembly.Memory = new Proxy(Memory, {construct() { throw new Error('import allocated memory'); }});
    const {initSync, AhoCorasick, StreamMatcher} = await import(${JSON.stringify(entry)});
    WebAssembly.Memory = Memory;
    initSync();
    const matcher = new AhoCorasick(['😀', 'é']);
    if (JSON.stringify(matcher.findIter('a😀é')) !== JSON.stringify([{pattern:0,start:1,end:3,text:'😀'},{pattern:1,start:3,end:4,text:'é'}])) throw new Error('matches differ');
    const stream = new StreamMatcher(['foo']);
    stream.write(new TextEncoder().encode('fo'));
    if (stream.write(new TextEncoder().encode('o'))[0]?.end !== 3) throw new Error('stream differs');
  `;
  const result = Bun.spawnSync([
    process.execPath,
    "-e",
    source,
  ]);
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});

// npm.cmd requires a shell on Windows; this packaging check runs on POSIX.
test.skipIf(process.platform === "win32")(
  "npm tarball contains and runs the single-thread entry and its runtime imports",
  () => {
    const directory = mkdtempSync(
      join(tmpdir(), "aho-single-thread-pack-"),
    );
    try {
      const output = execFileSync(
        "npm",
        [
          "pack",
          "--json",
          "--ignore-scripts",
          "--pack-destination",
          directory,
        ],
        {
          cwd: new URL("../wasm/", import.meta.url),
          encoding: "utf8",
        },
      );
      const [packed] = JSON.parse(output);
      const files = packed.files.map(
        (file: { path: string }) => file.path,
      );
      for (const expected of [
        "dist/single-thread.mjs",
        "dist/single-thread.d.mts",
        "dist/single-thread-inline.mjs",
        "dist/single-thread-inline.d.mts",
        "dist/aho-corasick.single-thread.wasm",
        "dist/single-thread-size.json",
      ])
        expect(files).toContain(expected);
      execFileSync("tar", [
        "-xzf",
        join(directory, packed.filename),
        "-C",
        directory,
      ]);
      const entry = pathToFileURL(
        join(
          directory,
          "package/dist/single-thread-inline.mjs",
        ),
      ).href;
      const result = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          `
      globalThis.fetch = () => {throw new Error('unexpected fetch')};
      Reflect.deleteProperty(globalThis, 'SharedArrayBuffer');
      Reflect.deleteProperty(globalThis, 'Worker');
      const {initSync, AhoCorasick} = await import(${JSON.stringify(entry)});
      initSync();
      if (!new AhoCorasick(['packed']).isMatch('packed')) throw new Error('packed runtime failed');
    `,
        ],
        { cwd: directory },
      );
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("explicit initialization accepts bytes or a caller URL and reports HTTP errors", async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  try {
    globalThis.fetch = (async (input) => {
      requested.push(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      return new Response(bytes);
    }) as typeof fetch;
    await init(bytes);
    expect(requested).toEqual([]);
    await init(
      new URL("https://extension.invalid/engine.wasm"),
    );
    expect(requested).toEqual([
      "https://extension.invalid/engine.wasm",
    ]);
    expect(new AhoCorasick(["ok"]).isMatch("ok")).toBe(
      true,
    );
    globalThis.fetch = (async () =>
      new Response("missing", {
        status: 404,
      })) as typeof fetch;
    await init(
      "https://extension.invalid/missing.wasm",
    ).then(
      () => {
        throw new Error("Expected HTTP rejection");
      },
      (error) => {
        if (!(error instanceof Error)) throw error;
        expect(error.message).toContain("404");
      },
    );
    expect(
      new AhoCorasick(["still initialized"]).isMatch(
        "still initialized",
      ),
    ).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("single-thread and existing threaded bindings produce identical public API results", () => {
  execFileSync(
    "node",
    [
      fileURLToPath(
        new URL(
          "./single-thread-parity.runtime.mjs",
          import.meta.url,
        ),
      ),
    ],
    { timeout: 60_000 },
  );
});
