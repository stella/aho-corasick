import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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

const RUNTIME_DEPENDENCY_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
];

const readManifest = async (path) =>
  JSON.parse(await readFile(path, "utf8"));

const declaredRuntimeDependencies = (manifest) =>
  new Set(
    RUNTIME_DEPENDENCY_FIELDS.flatMap((field) =>
      Object.keys(manifest[field] ?? {}),
    ),
  );

const incompatibleEngineDependencies = (
  manifest,
  dependencyManifests,
) => {
  const manifestRange = manifest.engines?.node;
  assert.equal(
    typeof manifestRange,
    "string",
    `${manifest.name} must declare engines.node`,
  );

  return [...declaredRuntimeDependencies(manifest)].filter(
    (dependency) => {
      const dependencyRange =
        dependencyManifests.get(dependency)?.engines?.node;
      return (
        typeof dependencyRange === "string" &&
        semver.subset(manifestRange, dependencyRange) ===
          false
      );
    },
  );
};

void test("published Node ranges satisfy every installed runtime dependency", async () => {
  for (const manifestPath of PUBLISHED_MANIFESTS) {
    const manifest = await readManifest(manifestPath);
    const dependencyManifests = new Map();

    for (const dependency of declaredRuntimeDependencies(
      manifest,
    )) {
      dependencyManifests.set(
        dependency,
        await readManifest(
          join("node_modules", dependency, "package.json"),
        ),
      );
    }

    assert.deepEqual(
      incompatibleEngineDependencies(
        manifest,
        dependencyManifests,
      ),
      [],
      `${manifestPath} supports Node versions rejected by a dependency`,
    );
  }
});

void test("a Node 18 manifest is rejected when a dependency requires Node 20.19", () => {
  const manifest = {
    name: "fixture",
    engines: { node: ">=18" },
    dependencies: { runtime: "1.0.0" },
  };
  const dependencyManifests = new Map([
    ["runtime", { engines: { node: "^20.19.0" } }],
  ]);

  assert.deepEqual(
    incompatibleEngineDependencies(
      manifest,
      dependencyManifests,
    ),
    ["runtime"],
  );
});
