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

const workspacePatterns = (manifest) => {
  if (Array.isArray(manifest.workspaces)) {
    return manifest.workspaces;
  }
  return manifest.workspaces?.packages ?? [];
};

const workspacePatternMatches = (pattern, manifestPath) => {
  const directory = manifestPath.replace(
    /\/package\.json$/u,
    "",
  );
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/gu, "\\$&")
    .replaceAll("**", "\0")
    .replaceAll("*", "[^/]*")
    .replaceAll("\0", ".*");
  return new RegExp(`^${escaped}$`, "u").test(directory);
};

/**
 * Return the Changesets package whose release determines each manifest's
 * version. Changesets owns the root and declared workspaces. This repository's
 * configured post-Changesets version synchronizer makes the root release own
 * the remaining generated N-API manifests.
 */
export const releaseOwners = ({
  manifests,
  changesetsConfig,
}) => {
  const [, rootManifest] = manifests.find(
    ([manifestPath]) => manifestPath === "package.json",
  ) ?? [undefined, undefined];
  if (rootManifest === undefined) {
    throw new Error(
      "package.json is not a published manifest",
    );
  }

  const ignored = new Set(changesetsConfig.ignore ?? []);
  const patterns = workspacePatterns(rootManifest);
  const managed = new Set(
    manifests
      .filter(
        ([manifestPath, manifest]) =>
          !ignored.has(manifest.name) &&
          (manifestPath === "package.json" ||
            patterns.some((pattern) =>
              workspacePatternMatches(
                pattern,
                manifestPath,
              ),
            )),
      )
      .map(([, manifest]) => manifest.name),
  );
  const synchronizesDerivedVersions =
    rootManifest.scripts?.["changeset:version"]?.includes(
      "version-sync.mjs sync",
    ) === true && rootManifest.napi !== undefined;

  return new Map(
    manifests.map(([, manifest]) => {
      if (managed.has(manifest.name)) {
        return [manifest.name, manifest.name];
      }
      if (
        synchronizesDerivedVersions &&
        manifest.version === rootManifest.version
      ) {
        return [manifest.name, rootManifest.name];
      }
      return [manifest.name, manifest.name];
    }),
  );
};

export const engineSupportDecisions = ({
  baseManifests,
  headManifests,
  changesets,
  changesetsConfig,
}) => {
  const baseByPath = new Map(baseManifests);
  const releases = changesetReleases(changesets);
  const owners = releaseOwners({
    manifests: headManifests,
    changesetsConfig,
  });

  return headManifests.map(
    ([manifestPath, headManifest]) => {
      const baseManifest =
        baseByPath.get(manifestPath) ?? {};
      return engineSupportDecision({
        packageName: headManifest.name,
        baseRange: baseManifest.engines?.node,
        headRange: headManifest.engines?.node,
        releaseType: releases.get(
          owners.get(headManifest.name),
        ),
      });
    },
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
  const [manifests, changesets, changesetsConfig] =
    await Promise.all([
      publishedManifests(root),
      pendingChangesets(root),
      readFile(
        nodePath.join(root, ".changeset", "config.json"),
        "utf8",
      ).then(JSON.parse),
    ]);
  const baseManifests = await Promise.all(
    manifests.map(async ([manifestPath]) => [
      manifestPath,
      await manifestAt(base, manifestPath).catch(
        () => ({}),
      ),
    ]),
  );
  const decisions = engineSupportDecisions({
    baseManifests,
    headManifests: manifests,
    changesets,
    changesetsConfig,
  });
  for (const decision of decisions) {
    if (decision.allowed === false) {
      throw new Error(decision.reason);
    }
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
