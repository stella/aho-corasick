import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUploadArtifacts } from "./create-crate-upload.mjs";

describe("crates.io upload artifact", () => {
  test("binds metadata and exact crate bytes into the registry payload", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "crate-upload-"),
    );
    const cratePath = join(
      directory,
      "example-core-1.2.3.crate",
    );
    const readmePath = join(directory, "README.md");
    const manifestPath = join(directory, "Cargo.toml");
    const uploadPath = join(directory, "upload.bin");
    const releaseManifestPath = join(
      directory,
      "release.json",
    );
    const crate = Buffer.from("prebuilt crate bytes");
    writeFileSync(cratePath, crate);
    writeFileSync(readmePath, "# Example\n");

    createUploadArtifacts({
      pkg: {
        name: "example-core",
        version: "1.2.3",
        manifest_path: manifestPath,
        dependencies: [
          {
            name: "aho-corasick",
            req: "^1",
            features: ["std"],
            optional: false,
            uses_default_features: true,
            target: null,
            kind: null,
            registry: null,
            rename: null,
          },
        ],
        features: {},
        authors: [],
        description: "Example",
        documentation: null,
        homepage: null,
        readme: "README.md",
        keywords: [],
        categories: [],
        license: "MIT",
        license_file: null,
        repository: null,
        links: null,
        rust_version: "1.85",
      },
      cratePath,
      uploadPath,
      manifestPath: releaseManifestPath,
    });

    const upload = readFileSync(uploadPath);
    const metadataLength = upload.readUInt32LE(0);
    const metadataEnd = 4 + metadataLength;
    const metadata = JSON.parse(
      upload.subarray(4, metadataEnd).toString("utf8"),
    );
    const crateLength = upload.readUInt32LE(metadataEnd);
    const uploadedCrate = upload.subarray(metadataEnd + 4);
    const releaseManifest = JSON.parse(
      readFileSync(releaseManifestPath, "utf8"),
    );

    expect(metadata).toMatchObject({
      name: "example-core",
      vers: "1.2.3",
      readme: "# Example\n",
      readme_file: "README.md",
      deps: [
        {
          name: "aho-corasick",
          version_req: "^1",
          kind: "normal",
        },
      ],
    });
    expect(crateLength).toBe(crate.length);
    expect(uploadedCrate).toEqual(crate);
    expect(releaseManifest).toMatchObject({
      name: "example-core",
      version: "1.2.3",
      crateFile: "example-core-1.2.3.crate",
      uploadFile: "upload.bin",
    });
    expect(releaseManifest.crateSha256).toHaveLength(64);
    expect(releaseManifest.uploadSha256).toHaveLength(64);
  });
});
