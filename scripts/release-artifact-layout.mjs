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

const STEP_NAME = "Upload WASM bindings";
const WASI_TARGET = "wasm32-wasip1-threads";

/** @param {string} workflow */
export const extractWasmUploadGlobs = (workflow) => {
  const lines = workflow.split("\n");
  const stepIndexes = lines.flatMap((line, index) =>
    line.trim() === `- name: ${STEP_NAME}` ? [index] : [],
  );
  if (stepIndexes.length !== 1) {
    throw new Error(
      `Expected exactly one ${STEP_NAME} step, found ${stepIndexes.length}`,
    );
  }

  const stepIndent = lines[stepIndexes[0]].search(/\S/u);
  const stepEnd = lines.findIndex(
    (line, index) =>
      index > stepIndexes[0] &&
      line.trim().startsWith("- ") &&
      line.search(/\S/u) === stepIndent,
  );
  const step = lines.slice(
    stepIndexes[0],
    stepEnd === -1 ? undefined : stepEnd,
  );
  const pathIndex = step.findIndex((line) => line.trim() === "path: |");
  if (pathIndex === -1) {
    throw new Error(`${STEP_NAME} must have a path block`);
  }

  const pathIndent = step[pathIndex].search(/\S/u);
  const globs = [];
  for (const line of step.slice(pathIndex + 1)) {
    const indent = line.search(/\S/u);
    if (line.trim() === "" || indent > pathIndent) {
      if (line.trim() !== "") globs.push(line.trim());
      continue;
    }
    break;
  }
  if (globs.length === 0) {
    throw new Error(`${STEP_NAME} path block has no globs`);
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
      throw new Error(`${STEP_NAME} globs matched no files`);
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
