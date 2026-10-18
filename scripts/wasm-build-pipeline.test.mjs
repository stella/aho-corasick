import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { validateWasmBuildCommands } from "./wasm-build-command.mjs";

const read = (path) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const { scripts } = JSON.parse(read("../package.json"));
const wasmPackage = JSON.parse(
  read("../wasm/package.json"),
);

test("the shared WASM build emits both artifacts before JavaScript packaging", () => {
  expect(scripts["build:wasm"]).toBe(
    "node scripts/build-wasm.mjs",
  );
  expect(scripts["build:js"]).toMatch(
    /^node scripts\/ensure-wasm-artifact\.mjs && .*node scripts\/pack-single-thread\.mjs$/,
  );
  const ensure = read("./ensure-wasm-artifact.mjs");
  expect(ensure).toContain(
    "await access(singleThreadPath, constants.F_OK)",
  );
  expect(ensure).toContain(
    'spawnSync("bun", ["run", "build:wasm"]',
  );
  expect(ensure).not.toContain("build-native.mjs");
});

test("packing the WASM package builds the single-thread artifact first", () => {
  expect(wasmPackage.scripts?.prepack).toBe(
    "cd .. && bun run build:wasm && bun run build:js",
  );
});

test("the release contract accepts only the declared WASM build wrapper", () => {
  expect(() =>
    validateWasmBuildCommands(scripts),
  ).not.toThrow();
  expect(() =>
    validateWasmBuildCommands({
      ...scripts,
      "build:wasm":
        "node scripts/build-single-thread.mjs && node scripts/build-native.mjs --platform --target wasm32-wasip1-threads --dts index.d.cts --release",
    }),
  ).toThrow(
    "build:wasm must be exactly node scripts/build-wasm.mjs",
  );
});

test("the single-thread build installs its target explicitly", () => {
  const build = read("./build-single-thread.mjs");
  expect(
    build.indexOf('["target", "add", target]'),
  ).toBeGreaterThan(-1);
  expect(
    build.indexOf('["target", "add", target]'),
  ).toBeLessThan(build.indexOf('  "cargo",'));
});

test("artifact runtime tests are explicitly scheduled after packaging", () => {
  expect(scripts["test:single-thread"]).toBe(
    "bun test ./__test__/single-thread.runtime.ts",
  );
  for (const path of [
    "../.github/workflows/ci.yml",
    "../.github/workflows/release.yml",
  ]) {
    const lines = read(path).split("\n");
    const runtimeSteps = lines.flatMap((line, index) =>
      line.trim() === "- run: bun run test:single-thread"
        ? [index]
        : [],
    );
    expect(runtimeSteps.length).toBeGreaterThan(0);
    for (const index of runtimeSteps) {
      expect(lines[index - 1].trim()).toBe(
        "- run: bun run build:js",
      );
    }
  }
});

test("changeset policy covers every workspace crate source and manifest", () => {
  const workflow = Bun.YAML.parse(
    read("../.github/workflows/ci.yml"),
  );
  const policy = workflow.jobs.changeset.steps.find(
    (step) => step.uses?.includes("/changeset-policy@"),
  );
  const globs = (name) =>
    policy.with[name]
      .trim()
      .split(/\s+/u)
      .map((pattern) => new Bun.Glob(pattern));
  const release = globs("release-paths");
  const generated = globs("generated-paths");
  const root = fileURLToPath(
    new URL("../", import.meta.url),
  );
  for (const pattern of [
    "crates/*/src/**/*.rs",
    "crates/*/Cargo.toml",
  ]) {
    const paths = [
      ...new Bun.Glob(pattern).scanSync({ cwd: root }),
    ];
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(
        release.some((glob) => glob.match(path)),
        path,
      ).toBe(true);
      if (path.endsWith("/Cargo.toml"))
        expect(
          generated.some((glob) => glob.match(path)),
          path,
        ).toBe(true);
    }
  }
});
