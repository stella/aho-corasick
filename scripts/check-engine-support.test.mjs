import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  engineSupportDecision,
  releaseOwners,
} from "./check-engine-support.mjs";

const execFileAsync = promisify(execFile);

const decide = (
  { baseRange, headRange, releaseType } = {
    baseRange: ">=18",
    headRange: ">=18",
  },
) =>
  engineSupportDecision({
    packageName: "fixture",
    baseRange,
    headRange,
    releaseType,
  });

void test("unchanged support needs no pending changeset", () => {
  assert.deepEqual(decide(), {
    allowed: true,
    supportReduced: false,
  });
});

void test("reduced support rejects a minor changeset", () => {
  assert.deepEqual(
    decide({ headRange: ">=20", releaseType: "minor" }),
    {
      allowed: false,
      supportReduced: true,
      reason:
        "fixture reduces engines.node support and requires a major changeset",
    },
  );
});

void test("reduced support accepts a major changeset", () => {
  assert.deepEqual(
    decide({ headRange: ">=20", releaseType: "major" }),
    {
      allowed: true,
      supportReduced: true,
    },
  );
});

void test("wider support needs no pending changeset", () => {
  assert.deepEqual(
    decide({ baseRange: ">=20", headRange: ">=18" }),
    {
      allowed: true,
      supportReduced: false,
    },
  );
});

void test("adding an engine range reduces unrestricted support", () => {
  assert.deepEqual(
    decide({ baseRange: undefined, headRange: ">=20" }),
    {
      allowed: false,
      supportReduced: true,
      reason:
        "fixture reduces engines.node support and requires a major changeset",
    },
  );
});

void test("removing an engine range widens support", () => {
  assert.deepEqual(
    decide({ baseRange: ">=20", headRange: undefined }),
    {
      allowed: true,
      supportReduced: false,
    },
  );
});

void test("derived manifests use their configured release owner", () => {
  const manifests = [
    [
      "package.json",
      {
        name: "root-fixture",
        version: "1.0.0",
        workspaces: ["packages/*"],
        napi: { targets: ["fixture-target"] },
        scripts: {
          "changeset:version":
            "changeset version && node scripts/version-sync.mjs sync",
        },
      },
    ],
    [
      "packages/managed/package.json",
      { name: "managed-fixture", version: "2.0.0" },
    ],
    [
      "npm/fixture-target/package.json",
      { name: "derived-fixture", version: "1.0.0" },
    ],
  ];

  assert.deepEqual(
    releaseOwners({
      manifests,
      changesetsConfig: { ignore: [] },
    }),
    new Map([
      ["root-fixture", "root-fixture"],
      ["managed-fixture", "managed-fixture"],
      ["derived-fixture", "root-fixture"],
    ]),
  );
});

void test("checks each published manifest against the git base", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "engine-support-"),
  );
  const run = (command, arguments_) =>
    execFileAsync(command, arguments_, { cwd: root });
  const writeManifest = (manifestPath, manifest) =>
    writeFile(
      path.join(root, manifestPath),
      `${JSON.stringify(manifest, undefined, 2)}\n`,
    );

  await Promise.all([
    mkdir(path.join(root, ".changeset")),
    mkdir(path.join(root, "wasm")),
  ]);
  await writeFile(
    path.join(root, ".changeset", "config.json"),
    '{"ignore": []}\n',
  );
  await writeFile(
    path.join(root, ".changeset", "README.md"),
    "# Changesets\n",
  );
  await writeManifest("package.json", {
    name: "root-fixture",
    version: "1.0.0",
    napi: { targets: ["wasm32-wasi"] },
    scripts: {
      "changeset:version":
        "changeset version && node scripts/version-sync.mjs sync",
    },
    engines: { node: ">=18" },
  });
  await writeManifest("wasm/package.json", {
    name: "wasm-fixture",
    version: "1.0.0",
    engines: { node: ">=18" },
  });
  await run("git", ["init"]);
  await run("git", [
    "config",
    "user.email",
    "fixture@example.com",
  ]);
  await run("git", ["config", "user.name", "Fixture"]);
  await run("git", ["add", "."]);
  await run("git", ["commit", "-m", "fixture base"]);
  await writeManifest("wasm/package.json", {
    name: "wasm-fixture",
    version: "1.0.0",
    engines: { node: ">=20" },
  });

  const script = new URL(
    "./check-engine-support.mjs",
    import.meta.url,
  ).pathname;
  await assert.rejects(
    run(process.execPath, [script, "--base", "HEAD"]),
    /wasm-fixture reduces engines\.node support/u,
  );

  await writeFile(
    path.join(root, ".changeset", "root-major.md"),
    '---\n"root-fixture": major\n---\n\nRequire newer Node.js.\n',
  );
  await run(process.execPath, [script, "--base", "HEAD"]);

  await writeFile(
    path.join(root, ".changeset", "root-major.md"),
    '---\n"root-fixture": minor\n---\n\nRequire newer Node.js.\n',
  );
  await assert.rejects(
    run(process.execPath, [script, "--base", "HEAD"]),
    /wasm-fixture reduces engines\.node support/u,
  );
});

void test("accepts this branch's committed changesets for its real engine diff", async () => {
  const root = new URL("../", import.meta.url).pathname;
  const { stdout: engineCommit } = await execFileAsync(
    "git",
    [
      "log",
      "-S",
      '"node": "^20.19.0 || ^22.13.0 || >=23.5.0"',
      "--format=%H",
      "--",
      "package.json",
    ],
    { cwd: root },
  );
  const changedAt = engineCommit.trim().split("\n").at(0);
  assert.ok(
    changedAt,
    "expected the engine-range commit in repository history",
  );
  const { stdout: base } = await execFileAsync(
    "git",
    ["rev-parse", `${changedAt}^`],
    { cwd: root },
  );
  const script = new URL(
    "./check-engine-support.mjs",
    import.meta.url,
  ).pathname;
  await execFileAsync(
    process.execPath,
    [script, "--base", base.trim()],
    { cwd: root },
  );
});
