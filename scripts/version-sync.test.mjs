import { describe, expect, test } from "bun:test";

import {
  resolveSyncVersions,
  rewriteLoaderVersion,
} from "./version-sync.mjs";

describe("version synchronization", () => {
  test("uses the pre-Changesets VERSION value to update the generated loader", () => {
    const transition = resolveSyncVersions({
      packageVersion: "1.1.0",
      requestedVersion: undefined,
      versionFileVersion: "1.0.4",
    });

    expect(transition).toEqual({
      previousVersion: "1.0.4",
      nextVersion: "1.1.0",
    });
    expect(
      rewriteLoaderVersion({
        content:
          "Native binding package version mismatch, expected 1.0.4",
        filePath: "index.cjs",
        ...transition,
      }),
    ).toBe(
      "Native binding package version mismatch, expected 1.1.0",
    );
  });

  test("allows an interrupted synchronization to be rerun", () => {
    expect(
      rewriteLoaderVersion({
        content:
          "Native binding package version mismatch, expected 1.1.0",
        filePath: "index.cjs",
        previousVersion: "1.0.4",
        nextVersion: "1.1.0",
      }),
    ).toBe(
      "Native binding package version mismatch, expected 1.1.0",
    );
  });
});
