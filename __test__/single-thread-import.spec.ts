import { expect, test } from "bun:test";

test("source import performs no I/O, allocation or worker startup in an SAB-less runtime", () => {
  const entry = new URL(
    "../src/single-thread.ts",
    import.meta.url,
  ).href;
  const result = Bun.spawnSync([
    process.execPath,
    "-e",
    `
    Reflect.deleteProperty(globalThis, 'SharedArrayBuffer');
    Reflect.deleteProperty(globalThis, 'Worker');
    globalThis.fetch = () => { throw new Error('unexpected fetch'); };
    WebAssembly.Memory = new Proxy(WebAssembly.Memory, {construct() { throw new Error('unexpected memory'); }});
    WebAssembly.Module = new Proxy(WebAssembly.Module, {construct() { throw new Error('unexpected compilation'); }});
    const api = await import(${JSON.stringify(entry)});
    try { new api.AhoCorasick(['x']); throw new Error('missing initialization accepted'); }
    catch (error) { if (!error.message.includes('Call init()')) throw error; }
  `,
  ]);
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});

test("initSync compiles only the bytes inside a Buffer view", () => {
  const entry = new URL(
    "../src/single-thread.ts",
    import.meta.url,
  ).href;
  const result = Bun.spawnSync([
    process.execPath,
    "-e",
    `
    const api = await import(${JSON.stringify(entry)});
    const allocation = Buffer.from([0xa5, 0xa5, 1, 2, 3, 4, 0xa5]);
    const view = allocation.subarray(2, 6);
    WebAssembly.Module = new Proxy(WebAssembly.Module, {
      construct(_target, [source]) {
        const compiled = new Uint8Array(source);
        if (compiled.length !== view.length || compiled.some((value, index) => value !== view[index])) {
          throw new Error('compiled bytes escaped the Buffer view');
        }
        throw new Error('view accepted');
      },
    });
    try { api.initSync(view); }
    catch (error) {
      if (error.message === 'view accepted') process.exit(0);
      throw error;
    }
    throw new Error('expected compilation');
  `,
  ]);
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});
