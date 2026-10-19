import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
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
    typeof baseRange === "string" &&
    (typeof headRange !== "string" ||
      semver.subset(baseRange, headRange) === false);

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

const pendingChangesets = async () => {
  const filenames = await readdir(
    new URL("../.changeset/", import.meta.url),
  );
  const pending = filenames.filter(
    (filename) =>
      filename.endsWith(".md") && filename !== "README.md",
  );
  return Promise.all(
    pending.map((filename) =>
      readFile(
        new URL(
          `../.changeset/${filename}`,
          import.meta.url,
        ),
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

const main = async () => {
  const baseFlag = process.argv.indexOf("--base");
  const base = process.argv.at(baseFlag + 1);
  if (baseFlag === -1 || !base) {
    throw new Error(
      "Usage: check-engine-support.mjs --base <ref>",
    );
  }

  // Changesets manages the root package in this repository. Generated platform
  // manifests are synchronized with it by the release tooling.
  const manifestPath = "package.json";
  const [baseManifest, headManifest, changesets] =
    await Promise.all([
      manifestAt(base, manifestPath),
      readFile(
        new URL(`../${manifestPath}`, import.meta.url),
        "utf8",
      ).then(JSON.parse),
      pendingChangesets(),
    ]);
  const releases = changesetReleases(changesets);
  const decision = engineSupportDecision({
    packageName: headManifest.name,
    baseRange: baseManifest.engines?.node,
    headRange: headManifest.engines?.node,
    releaseType: releases.get(headManifest.name),
  });

  if (!decision.allowed) {
    throw new Error(decision.reason);
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
