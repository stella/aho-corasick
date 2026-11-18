import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { isRecord } from "./release-script-inputs.mjs";

const INPUT_NAME = "wasm-artifact-paths";
const WASI_TARGET = "wasm32-wasip1-threads";

// The shared release workflow uploads the WASM build with the caller's
// `wasm-artifact-paths` input, so the release job's block is the manifest.
/** @param {string} workflow */
export const extractWasmUploadGlobs = (workflow) => {
  const lines = workflow.split("\n");
  const inputIndexes = lines.flatMap((line, index) =>
    line.trim().startsWith(`${INPUT_NAME}:`) ? [index] : [],
  );
  if (inputIndexes.length !== 1) {
    throw new Error(
      `Expected exactly one ${INPUT_NAME} input, found ${inputIndexes.length}`,
    );
  }

  const input = lines[inputIndexes[0]];
  if (input.trim() !== `${INPUT_NAME}: |`) {
    throw new Error(`${INPUT_NAME} must be a block of globs`);
  }
  const inputIndent = input.search(/\S/u);
  const globs = [];
  for (const line of lines.slice(inputIndexes[0] + 1)) {
    const indent = line.search(/\S/u);
    if (line.trim() === "" || indent > inputIndent) {
      if (line.trim() !== "") globs.push(line.trim());
      continue;
    }
    break;
  }
  if (globs.length === 0) {
    throw new Error(`${INPUT_NAME} has no globs`);
  }
  return globs;
};

/** @param {string} glob */
const globRegex = (glob) =>
  new RegExp(
    `^${glob.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*")}$`,
    "u",
  );

/** @param {string[]} globs
 * @param {string} name
 */
const matchesUpload = (globs, name) => {
  const includes = globs.filter((glob) => !glob.startsWith("!"));
  const excludes = globs
    .filter((glob) => glob.startsWith("!"))
    .map((glob) => glob.slice(1));
  return (
    includes.some((glob) => globRegex(glob).test(name)) &&
    !excludes.some((glob) => globRegex(glob).test(name))
  );
};

const run = async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const workflowPath = join(root, ".github/workflows/release.yml");
  const globs = extractWasmUploadGlobs(await readFile(workflowPath, "utf8"));
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "aho-corasick-release-artifacts-"),
  );

  try {
    const artifactDirectory = join(
      temporaryRoot,
      "artifacts",
      `bindings-${WASI_TARGET}`,
    );
    await mkdir(artifactDirectory, { recursive: true });
    const entries = await readdir(root, {
      withFileTypes: true,
    });
    const uploaded = entries.filter(
      (entry) => entry.isFile() && matchesUpload(globs, entry.name),
    );
    if (uploaded.length === 0) {
      throw new Error(`${INPUT_NAME} globs matched no files`);
    }
    await Promise.all(
      uploaded.map((entry) =>
        cp(join(root, entry.name), join(artifactDirectory, entry.name)),
      ),
    );

    /** @type {unknown} */
    const manifestValue = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    );
    if (!isRecord(manifestValue) || !isRecord(manifestValue["napi"])) {
      throw new Error("package.json has no napi configuration");
    }
    const manifest = {
      ...manifestValue,
      napi: {
        ...manifestValue["napi"],
        targets: [WASI_TARGET],
      },
    };
    await writeFile(
      join(temporaryRoot, "package.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await mkdir(join(temporaryRoot, "npm"), {
      recursive: true,
    });
    const cli = join(root, "node_modules/@napi-rs/cli/dist/cli.js");
    const result = spawnSync(
      process.execPath,
      [
        cli,
        "artifacts",
        "--cwd",
        temporaryRoot,
        "--package-json-path",
        "package.json",
        "--output-dir",
        "artifacts",
        "--npm-dir",
        "npm",
        "--build-output-dir",
        artifactDirectory,
      ],
      { encoding: "utf8", stdio: "pipe" },
    );
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.status !== 0) process.exitCode = result.status ?? 1;
  } finally {
    await rm(temporaryRoot, {
      recursive: true,
      force: true,
    });
  }
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  await run();
}
