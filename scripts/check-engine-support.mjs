import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import nodePath from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import semver from "semver";

const execFileAsync = promisify(execFile);

export const engineSupportDecision = ({
  packageName,
  baseRange,
  headRange,
  releaseType,
}) => {
  const supportReduced =
    semver.subset(baseRange ?? "*", headRange ?? "*") ===
    false;

  if (!supportReduced || releaseType === "major") {
    return { allowed: true, supportReduced };
  }

  return {
    allowed: false,
    supportReduced,
    reason: `${packageName} reduces engines.node support and requires a major changeset`,
  };
};

export const changesetReleases = (sources) => {
  const releases = new Map();
  for (const source of sources) {
    const frontmatter =
      source.match(/^---\n([\s\S]*?)\n---/u)?.at(1) ?? "";
    for (const match of frontmatter.matchAll(
      /^"([^"]+)": (patch|minor|major)$/gmu,
    )) {
      const packageName = match.at(1);
      const releaseType = match.at(2);
      if (
        packageName !== undefined &&
        releaseType !== undefined &&
        ["patch", "minor", "major"].indexOf(releaseType) >
          ["patch", "minor", "major"].indexOf(
            releases.get(packageName),
          )
      ) {
        releases.set(packageName, releaseType);
      }
    }
  }
  return releases;
};

const pendingChangesets = async (root) => {
  const changesetDirectory = nodePath.join(
    root,
    ".changeset",
  );
  const filenames = await readdir(changesetDirectory);
  const pending = filenames.filter(
    (filename) =>
      filename.endsWith(".md") && filename !== "README.md",
  );
  return Promise.all(
    pending.map((filename) =>
      readFile(
        nodePath.join(changesetDirectory, filename),
        "utf8",
      ),
    ),
  );
};

const manifestAt = async (base, path) => {
  const { stdout } = await execFileAsync("git", [
    "show",
    `${base}:${path}`,
  ]);
  return JSON.parse(stdout);
};

const publishedManifests = async (root) => {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "*package.json"],
    { cwd: root },
  );
  const paths = stdout
    .split("\n")
    .filter((manifestPath) =>
      manifestPath.endsWith("package.json"),
    );
  const manifests = await Promise.all(
    paths.map(async (manifestPath) => [
      manifestPath,
      JSON.parse(
        await readFile(
          nodePath.join(root, manifestPath),
          "utf8",
        ),
      ),
    ]),
  );
  return manifests.filter(
    ([, manifest]) => manifest.private !== true,
  );
};

const main = async () => {
  const baseFlag = process.argv.indexOf("--base");
  const base = process.argv.at(baseFlag + 1);
  if (baseFlag === -1 || !base) {
    throw new Error(
      "Usage: check-engine-support.mjs --base <ref>",
    );
  }

  const root = process.cwd();
  const [manifests, changesets] = await Promise.all([
    publishedManifests(root),
    pendingChangesets(root),
  ]);
  const releases = changesetReleases(changesets);
  for (const [manifestPath, headManifest] of manifests) {
    const baseManifest = await manifestAt(
      base,
      manifestPath,
    ).catch(() => ({}));
    const decision = engineSupportDecision({
      packageName: headManifest.name,
      baseRange: baseManifest.engines?.node,
      headRange: headManifest.engines?.node,
      releaseType: releases.get(headManifest.name),
    });

    if (!decision.allowed) {
      throw new Error(decision.reason);
    }
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
