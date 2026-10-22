import { describe, expect, test } from "bun:test";

import {
  validateChecksumInventory,
  validateChecksums,
  validateWorkflowRun,
} from "./release-recovery.mjs";

const expected = {
  repository: "stella/aho-corasick",
  headSha: "abc123",
};
const matchingRun = {
  repository: { full_name: expected.repository },
  path: ".github/workflows/release.yml",
  head_branch: "main",
  event: "workflow_dispatch",
  head_sha: expected.headSha,
};

describe("release recovery source run", () => {
  test("accepts a matching run", () => {
    expect(() => validateWorkflowRun(matchingRun, expected)).not.toThrow();
  });

  for (const { name, patch } of [
    {
      name: "another repository",
      patch: { repository: { full_name: "someone/fork" } },
    },
    {
      name: "another workflow path",
      patch: { path: ".github/workflows/other.yml" },
    },
    {
      name: "another branch",
      patch: { head_branch: "release" },
    },
    {
      name: "another event",
      patch: { event: "pull_request" },
    },
    {
      name: "another head SHA",
      patch: { head_sha: "def456" },
    },
  ]) {
    test(`refuses ${name}`, () => {
      expect(() =>
        validateWorkflowRun({ ...matchingRun, ...patch }, expected),
      ).toThrow("Source run validation failed");
    });
  }
});

describe("release recovery checksums", () => {
  const hash = "a".repeat(64);

  test("accepts an exact tarball inventory", () => {
    expect(() =>
      validateChecksumInventory(`${hash}  ./package.tgz\n`, ["package.tgz"]),
    ).not.toThrow();
  });

  test("refuses a malformed SHA256SUMS entry", () => {
    expect(() =>
      validateChecksumInventory(`not-a-hash  ./package.tgz\n`, ["package.tgz"]),
    ).toThrow("Invalid SHA256SUMS entry");
  });

  test("refuses a SHA256SUMS mismatch", () => {
    expect(() =>
      validateChecksums(
        `${hash}  ./package.tgz\n`,
        new Map([["package.tgz", "bytes"]]),
      ),
    ).toThrow("Checksum mismatch: package.tgz");
  });

  test("refuses an unlisted tarball", () => {
    expect(() =>
      validateChecksumInventory(`${hash}  ./package.tgz\n`, [
        "package.tgz",
        "extra.tgz",
      ]),
    ).toThrow("Unlisted tarballs: extra.tgz");
  });

  test("refuses a missing listed file", () => {
    expect(() =>
      validateChecksumInventory(
        `${hash}  ./package.tgz\n${hash}  ./missing.tgz\n`,
        ["package.tgz"],
      ),
    ).toThrow("Missing listed tarballs: missing.tgz");
  });
});
