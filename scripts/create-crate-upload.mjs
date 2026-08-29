import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  basename,
  dirname,
  relative,
  resolve,
} from "node:path";
import { pathToFileURL } from "node:url";

const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");

const packagePath = (packageRoot, path) =>
  path === null ? null : resolve(packageRoot, path);

const relativeManifestPath = (packageRoot, path) => {
  const resolved = packagePath(packageRoot, path);
  return resolved === null
    ? null
    : relative(packageRoot, resolved);
};

export const createPublishMetadata = (pkg) => {
  const packageRoot = dirname(pkg.manifest_path);
  const readmeFile = relativeManifestPath(
    packageRoot,
    pkg.readme,
  );

  return {
    name: pkg.name,
    vers: pkg.version,
    deps: pkg.dependencies.map((dependency) => ({
      name: dependency.name,
      version_req: dependency.req,
      features: dependency.features,
      optional: dependency.optional,
      default_features: dependency.uses_default_features,
      target: dependency.target,
      kind: dependency.kind ?? "normal",
      registry: dependency.registry,
      explicit_name_in_toml: dependency.rename,
    })),
    features: pkg.features,
    authors: pkg.authors,
    description: pkg.description,
    documentation: pkg.documentation,
    homepage: pkg.homepage,
    readme:
      pkg.readme === null
        ? null
        : readFileSync(
            packagePath(packageRoot, pkg.readme),
            "utf8",
          ),
    readme_file: readmeFile,
    keywords: pkg.keywords,
    categories: pkg.categories,
    license: pkg.license,
    license_file: relativeManifestPath(
      packageRoot,
      pkg.license_file,
    ),
    repository: pkg.repository,
    badges: {},
    links: pkg.links,
    rust_version: pkg.rust_version,
  };
};

export const createUploadArtifacts = ({
  pkg,
  cratePath,
  uploadPath,
  manifestPath,
}) => {
  const crate = readFileSync(cratePath);
  const metadata = Buffer.from(
    JSON.stringify(createPublishMetadata(pkg)),
  );
  const metadataLength = Buffer.alloc(4);
  const crateLength = Buffer.alloc(4);
  metadataLength.writeUInt32LE(metadata.length);
  crateLength.writeUInt32LE(crate.length);
  const upload = Buffer.concat([
    metadataLength,
    metadata,
    crateLength,
    crate,
  ]);

  writeFileSync(uploadPath, upload);
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        name: pkg.name,
        version: pkg.version,
        crateFile: basename(cratePath),
        crateSha256: sha256(crate),
        uploadFile: basename(uploadPath),
        uploadSha256: sha256(upload),
      },
      null,
      2,
    )}\n`,
  );
};

const main = () => {
  const [packageName, cratePath, uploadPath, manifestPath] =
    process.argv.slice(2);
  if (
    !(
      packageName &&
      cratePath &&
      uploadPath &&
      manifestPath
    )
  ) {
    throw new Error(
      "usage: create-crate-upload.mjs <package> <crate> <upload> <manifest>",
    );
  }

  const metadata = JSON.parse(
    execFileSync(
      "cargo",
      ["metadata", "--format-version", "1", "--no-deps"],
      {
        encoding: "utf8",
      },
    ),
  );
  const pkg = metadata.packages.find(
    (candidate) => candidate.name === packageName,
  );
  if (!pkg) {
    throw new Error(
      `cargo metadata did not contain ${packageName}`,
    );
  }

  const expectedCrate = `${pkg.name}-${pkg.version}.crate`;
  if (basename(cratePath) !== expectedCrate) {
    throw new Error(
      `expected crate ${expectedCrate}, received ${basename(cratePath)}`,
    );
  }

  createUploadArtifacts({
    pkg,
    cratePath,
    uploadPath,
    manifestPath,
  });
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
