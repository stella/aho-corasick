import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import semver from "semver";

const changesetReleases = (source) => {
  const frontmatter =
    source.match(/^---\n([\s\S]*?)\n---/u)?.at(1) ?? "";
  return new Map(
    [
      ...frontmatter.matchAll(
        /^"([^"]+)": (patch|minor|major)$/gmu,
      ),
    ].map((match) => [match.at(1), match.at(2)]),
  );
};

const assertMajorForReducedNodeSupport = ({
  packageName,
  previousRange,
  nextRange,
  releases,
}) => {
  if (
    semver.subset(
      String(previousRange),
      String(nextRange),
    ) === true
  )
    return;
  assert.equal(
    releases.get(packageName),
    "major",
    `${packageName} reduces engines.node support and requires a major changeset`,
  );
};

void test("the Node support reduction has major release entries", async () => {
  const changeset = await readFile(
    new URL(
      "../.changeset/fresh-runtimes-agree.md",
      import.meta.url,
    ),
    "utf8",
  );
  const releases = changesetReleases(changeset);
  for (const packageName of ["@stll/aho-corasick"]) {
    assertMajorForReducedNodeSupport({
      packageName,
      previousRange: ">=18",
      nextRange: "^20.19.0 || ^22.13.0 || >=23.5.0",
      releases,
    });
  }
});

void test("a below-major changeset cannot reduce engines.node support", () => {
  assert.throws(
    () =>
      assertMajorForReducedNodeSupport({
        packageName: "fixture",
        previousRange: ">=18",
        nextRange: ">=20",
        releases: new Map([["fixture", "minor"]]),
      }),
    /requires a major changeset/u,
  );
});
