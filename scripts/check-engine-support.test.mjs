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

import { engineSupportDecision } from "./check-engine-support.mjs";

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
    path.join(root, ".changeset", "README.md"),
    "# Changesets\n",
  );
  await writeManifest("package.json", {
    name: "root-fixture",
    engines: { node: ">=18" },
  });
  await writeManifest("wasm/package.json", {
    name: "wasm-fixture",
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
    path.join(root, ".changeset", "wasm-major.md"),
    '---\n"wasm-fixture": major\n---\n\nRequire newer Node.js.\n',
  );
  await run(process.execPath, [script, "--base", "HEAD"]);
});
