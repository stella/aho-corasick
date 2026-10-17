import { describe, expect, test } from "bun:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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

test("version check traverses a CycloneDX SBOM without package-manifest fields", async () => {
  const root = await realpath(
    await mkdtemp(
      path.join(tmpdir(), "version-provenance-"),
    ),
  );
  const version = "1.0.4";
  const packageName = "@stll/aho-corasick";
  /** @param {string} relative
   * @param {string} content */
  const write = async (relative, content) => {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  };
  try {
    await mkdir(path.join(root, "scripts"));
    await mkdir(path.join(root, "npm"));
    for (const file of [
      "version-sync.mjs",
      "release-script-inputs.mjs",
    ])
      await copyFile(
        new URL(file, import.meta.url),
        path.join(root, "scripts", file),
      );
    await write("VERSION", `${version}\n`);
    await write(
      "package.json",
      JSON.stringify({ name: packageName, version }),
    );
    await write(
      "wasm/package.json",
      JSON.stringify({
        name: `${packageName}-wasm`,
        version,
      }),
    );
    await write(
      "Cargo.toml",
      `[package]\nname = "fixture-native"\nversion = "${version}"\npublish = false\n`,
    );
    await write(
      "crates/core/Cargo.toml",
      `[package]\nname = "fixture-core"\nversion = "${version}"\npublish = ["crates-io"]\n`,
    );
    await write("crates/core/LICENSE", "Fixture license\n");
    await write("crates/core/README.md", "Fixture crate\n");
    await write(
      "Cargo.lock",
      ["fixture-native", "fixture-core"]
        .map(
          (name) =>
            `[[package]]\nname = "${name}"\nversion = "${version}"\n`,
        )
        .join("\n"),
    );
    await write("bun.lock", "{}\n");
    const components = [
      {
        type: "library",
        name: packageName,
        version,
        purl: `pkg:npm/${packageName}@${version}`,
      },
      ...["fixture-native", "fixture-core"].map((name) => ({
        type: "library",
        name,
        version,
        purl: `pkg:cargo/${name}@${version}`,
      })),
    ];
    const sbom = {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      components,
    };
    await write(
      "provenance/sbom.cdx.json",
      JSON.stringify(sbom),
    );
    const run = () =>
      Bun.spawnSync(
        [
          "node",
          path.join(root, "scripts/version-sync.mjs"),
          "check",
        ],
        { cwd: root },
      );
    const valid = run();
    expect(valid.stderr.toString()).toBe("");
    expect(valid.exitCode).toBe(0);
    for (const component of components)
      component.version = "0.0.0";
    await write(
      "provenance/sbom.cdx.json",
      JSON.stringify(sbom),
    );
    const drift = run();
    expect(drift.exitCode).toBe(1);
    expect(drift.stderr.toString()).toContain(
      "sbom.cdx.json: pkg:cargo/fixture-core@1.0.4: version=0.0.0",
    );
    expect(drift.stderr.toString()).not.toContain(
      "Release manifest requires",
    );
    const malformed = {
      ...sbom,
      components: components.map(
        ({ type, name, purl }) => ({
          type,
          name,
          purl,
          version: { unexpected: true },
        }),
      ),
    };
    await write(
      "provenance/sbom.cdx.json",
      JSON.stringify(malformed),
    );
    const malformedResult = run();
    expect(malformedResult.exitCode).toBe(1);
    expect(malformedResult.stderr.toString()).toContain(
      'version={"unexpected":true}',
    );
    expect(malformedResult.stderr.toString()).not.toContain(
      "[object Object]",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
