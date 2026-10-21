import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export const validateWorkflowRun = (run, expected) => {
  const mismatches = [];
  if (run.repository?.full_name !== expected.repository)
    mismatches.push("repository");
  if (run.path !== ".github/workflows/release.yml")
    mismatches.push("workflow path");
  if (run.head_branch !== "main")
    mismatches.push("head branch");
  if (
    !new Set(["push", "workflow_dispatch"]).has(run.event)
  )
    mismatches.push("event");
  if (run.head_sha !== expected.headSha)
    mismatches.push("head SHA");
  if (mismatches.length > 0)
    throw new Error(
      `Source run validation failed: ${mismatches.join(", ")}`,
    );
};

export const validateChecksumInventory = (
  manifest,
  tarballs,
) => {
  const listed = new Set();
  for (const [lineNumber, line] of manifest
    .split("\n")
    .entries()) {
    if (line.length === 0) continue;
    const match =
      /^[0-9a-fA-F]{64}  (\.\/)?([^/]+\.tgz)$/u.exec(line);
    if (match === null)
      throw new Error(
        `Invalid SHA256SUMS entry on line ${lineNumber + 1}`,
      );
    const filename = match.at(2);
    if (filename === undefined || listed.has(filename))
      throw new Error(
        `Duplicate or invalid SHA256SUMS entry on line ${lineNumber + 1}`,
      );
    listed.add(filename);
  }

  const actual = new Set(
    tarballs.map((file) => basename(file)),
  );
  const unlisted = [...actual].filter(
    (file) => !listed.has(file),
  );
  const missing = [...listed].filter(
    (file) => !actual.has(file),
  );
  if (unlisted.length > 0)
    throw new Error(
      `Unlisted tarballs: ${unlisted.sort((left, right) => left.localeCompare(right)).join(", ")}`,
    );
  if (missing.length > 0)
    throw new Error(
      `Missing listed tarballs: ${missing.sort((left, right) => left.localeCompare(right)).join(", ")}`,
    );
  if (actual.size === 0)
    throw new Error("No release tarballs found");
};

export const validateChecksums = (manifest, files) => {
  validateChecksumInventory(manifest, [...files.keys()]);
  const expected = new Map(
    manifest
      .trim()
      .split("\n")
      .map((line) => {
        const [digest, filename] =
          line.split(/  (?:\.\/)?/u);
        return [filename, digest.toLowerCase()];
      }),
  );
  for (const [filename, contents] of files) {
    const actual = createHash("sha256")
      .update(contents)
      .digest("hex");
    if (actual !== expected.get(basename(filename)))
      throw new Error(
        `Checksum mismatch: ${basename(filename)}`,
      );
  }
};

const main = async () => {
  const [command, ...args] = process.argv.slice(2);
  if (command === "validate-run") {
    const [repository, headSha] = args;
    if (repository === undefined || headSha === undefined)
      throw new Error(
        "Usage: validate-run <repository> <head-sha>",
      );
    const input = await Bun.stdin.text();
    validateWorkflowRun(JSON.parse(input), {
      repository,
      headSha,
    });
    return;
  }
  if (command === "validate-checksums") {
    const [directory] = args;
    if (directory === undefined)
      throw new Error(
        "Usage: validate-checksums <directory>",
      );
    const tarballs = readdirSync(directory).filter((file) =>
      file.endsWith(".tgz"),
    );
    validateChecksums(
      readFileSync(join(directory, "SHA256SUMS"), "utf8"),
      new Map(
        tarballs.map((file) => [
          file,
          readFileSync(join(directory, file)),
        ]),
      ),
    );
    return;
  }
  throw new Error(
    "Expected validate-run or validate-checksums command",
  );
};

if (import.meta.main) await main();
