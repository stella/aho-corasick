import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { arch, platform } from "node:process";
import { test } from "node:test";
import semver from "semver";

const PUBLISHED_MANIFESTS = [
  "package.json",
  "wasm/package.json",
  "npm/darwin-arm64/package.json",
  "npm/darwin-x64/package.json",
  "npm/linux-arm64-gnu/package.json",
  "npm/linux-x64-gnu/package.json",
  "npm/wasm32-wasi/package.json",
  "npm/win32-x64-msvc/package.json",
];
const REQUIRED_DEPENDENCY_FIELDS = ["dependencies", "peerDependencies"];

const readManifest = async (path) => JSON.parse(await readFile(path, "utf8"));
const dependencyDeclarations = (manifest) => [
  ...REQUIRED_DEPENDENCY_FIELDS.flatMap((field) =>
    Object.keys(manifest[field] ?? {}).map((name) => ({
      name,
      optional: false,
    })),
  ),
  ...Object.keys(manifest.optionalDependencies ?? {}).map((name) => ({
    name,
    optional: true,
  })),
];
const platformListAllows = (values, current) => {
  if (!Array.isArray(values)) return true;
  const denied = values.some((value) => String(value) === `!${current}`);
  const allowed = values.filter((value) => !String(value).startsWith("!"));
  return !denied && (allowed.length === 0 || allowed.includes(current));
};
const supportsCurrentPlatform = (manifest) =>
  platformListAllows(manifest.os, platform) &&
  platformListAllows(manifest.cpu, arch);
const readIfPresent = async (path) => {
  try {
    return await readManifest(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
};
const lockfilePackageMetadata = async (dependency) => {
  const lockfile = await readFile("bun.lock", "utf8");
  const escaped = dependency.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const entry = lockfile
    .match(new RegExp(`^    "${escaped}": (\\[.*\\]),?$`, "mu"))
    ?.at(1);
  if (entry === undefined) return undefined;
  const metadata = JSON.parse(entry).at(2) ?? {};
  return metadata.os === undefined && metadata.cpu === undefined
    ? undefined
    : metadata;
};
const cachedPackageManifest = async (dependency) => {
  const cacheRoots = [
    "node_modules/.bun",
    join(process.env.HOME ?? "", ".bun/install/cache"),
  ];
  for (const root of cacheRoots) {
    let entries;
    try {
      entries = await readdir(root, {
        recursive: true,
        withFileTypes: true,
      });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.name !== "package.json") continue;
      const manifest = await readIfPresent(join(entry.parentPath, entry.name));
      if (manifest?.name === dependency) return manifest;
    }
  }
  return undefined;
};
const absentOptionalIsIncompatible = async (dependency) => {
  const metadata =
    (await lockfilePackageMetadata(dependency)) ??
    (await cachedPackageManifest(dependency));
  assert.ok(
    metadata !== undefined,
    `${dependency} is absent and has no platform metadata proving it is optional here`,
  );
  return !supportsCurrentPlatform(metadata);
};
const resolveDependencyManifests = async (
  manifest,
  {
    firstParty,
    readInstalled = (dependency) =>
      readIfPresent(join("node_modules", dependency, "package.json")),
    absentOptionalAllowed = absentOptionalIsIncompatible,
  },
) => {
  const dependencies = new Map();
  for (const declaration of dependencyDeclarations(manifest)) {
    const localManifest = firstParty.get(declaration.name);
    if (localManifest !== undefined) {
      dependencies.set(declaration.name, localManifest);
      continue;
    }
    const installedManifest = await readInstalled(declaration.name);
    if (installedManifest !== undefined) {
      dependencies.set(declaration.name, installedManifest);
      continue;
    }
    assert.ok(
      declaration.optional && (await absentOptionalAllowed(declaration.name)),
      `${declaration.name} must be installed on ${platform}/${arch}`,
    );
  }
  return dependencies;
};
const incompatibleEngineDependencies = (manifest, dependencyManifests) => {
  const manifestRange = manifest.engines?.node;
  assert.equal(
    typeof manifestRange,
    "string",
    `${manifest.name} must declare engines.node`,
  );
  return [...dependencyManifests].flatMap(
    ([dependency, dependencyManifest]) => {
      const dependencyRange = dependencyManifest.engines?.node;
      return typeof dependencyRange === "string" &&
        semver.subset(manifestRange, dependencyRange) === false
        ? [dependency]
        : [];
    },
  );
};

void test("published Node ranges satisfy every runtime dependency", async () => {
  const manifests = await Promise.all(
    PUBLISHED_MANIFESTS.map(async (path) => [path, await readManifest(path)]),
  );
  const firstParty = new Map(
    manifests.map(([, manifest]) => [manifest.name, manifest]),
  );
  for (const [manifestPath, manifest] of manifests) {
    const dependencyManifests = await resolveDependencyManifests(manifest, {
      firstParty,
    });
    assert.deepEqual(
      incompatibleEngineDependencies(manifest, dependencyManifests),
      [],
      `${manifestPath} supports Node versions rejected by a dependency`,
    );
  }
});
void test("an absent optional dependency for another platform is allowed", async () => {
  const dependencies = await resolveDependencyManifests(
    { optionalDependencies: { "other-platform": "1.0.0" } },
    {
      firstParty: new Map(),
      readInstalled: () => Promise.resolve(undefined),
      absentOptionalAllowed: () => Promise.resolve(true),
    },
  );
  assert.equal(dependencies.size, 0);
});
void test("an absent optional dependency for this platform is rejected", async () => {
  await assert.rejects(
    resolveDependencyManifests(
      {
        optionalDependencies: {
          "current-platform": "1.0.0",
        },
      },
      {
        firstParty: new Map(),
        readInstalled: () => Promise.resolve(undefined),
        absentOptionalAllowed: () => Promise.resolve(false),
      },
    ),
    /current-platform must be installed/u,
  );
});
void test("first-party platform manifests are checked without installed packages", async () => {
  const local = {
    name: "@stll/platform",
    engines: { node: ">=22" },
  };
  const dependencies = await resolveDependencyManifests(
    { optionalDependencies: { "@stll/platform": "1.0.0" } },
    {
      firstParty: new Map([[local.name, local]]),
      readInstalled: () => Promise.reject(new Error("read node_modules")),
    },
  );
  assert.equal(dependencies.get(local.name), local);
});
void test("a Node 18 manifest is rejected when a dependency requires Node 20.19", () => {
  const manifest = {
    name: "fixture",
    engines: { node: ">=18" },
  };
  const dependencyManifests = new Map([
    ["runtime", { engines: { node: "^20.19.0" } }],
  ]);
  assert.deepEqual(
    incompatibleEngineDependencies(manifest, dependencyManifests),
    ["runtime"],
  );
});
