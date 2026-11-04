---
"@stll/aho-corasick": patch
---

The browser WebAssembly loader passes its worker options as a static object literal again, so Vite and other bundlers can resolve `new Worker(new URL(...), { type: "module" })` at build time. 2.0 passed a variable that also carried `workerData`, which browser workers ignore; the loader already posts the crash flag to each worker.
