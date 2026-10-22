import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { normalizeGeneratedLoader } from "./generated-loader-normalization.mjs";

const cliPath = new URL(
  "../node_modules/@napi-rs/cli/dist/cli.js",
  import.meta.url,
);

const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(cliPath),
    "build",
    "--js",
    "index.cjs",
    ...process.argv.slice(2),
  ],
  {
    stdio: "inherit",
  },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

async function normalizeGeneratedFile(fileName, options) {
  const fileUrl = new URL(`../${fileName}`, import.meta.url);
  try {
    const content = await readFile(fileUrl, "utf8");
    await writeFile(fileUrl, normalizeGeneratedLoader(content, options));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

await normalizeGeneratedFile("aho-corasick.wasi-browser.js", {
  keepGeneratedTypecheckOptOut: true,
});
await normalizeGeneratedFile("aho-corasick.wasi.cjs", {
  keepGeneratedTypecheckOptOut: true,
});
await normalizeGeneratedFile("wasi-worker-browser.mjs");
await normalizeGeneratedFile("wasi-worker.mjs");

const declarationUrl = new URL("../index.d.cts", import.meta.url);
const declaration = await readFile(declarationUrl, "utf8");
const defaultExportDeclaration =
  "\ndeclare const binding: import('./src/core').NativeBinding\nexport default binding\n";
if (!declaration.includes("export default binding")) {
  await writeFile(
    declarationUrl,
    `${declaration.trimEnd()}\n${defaultExportDeclaration}`,
  );
}

const contractResult = spawnSync(
  "bun",
  [
    fileURLToPath(new URL("./wasi-artifact-contract.mjs", import.meta.url)),
    "--generated",
  ],
  { stdio: "inherit" },
);

if (contractResult.status !== 0) {
  process.exit(contractResult.status ?? 1);
}
