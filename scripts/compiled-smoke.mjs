import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(
  new URL("../", import.meta.url),
);
const packageJson = JSON.parse(
  await readFile(
    path.join(repositoryRoot, "package.json"),
    "utf8",
  ),
);
assert.equal(typeof packageJson.name, "string");
const packageName = packageJson.name;
const packageRoot = path.join(
  "node_modules",
  ...packageName.split("/"),
);
const temporaryRoot = await mkdtemp(
  path.join(tmpdir(), "aho-corasick-compiled-"),
);
const expectedOutput =
  '[{"pattern":0,"start":0,"end":3,"text":"foo"}]';

const run = (command, args) =>
  spawnSync(command, args, {
    cwd: temporaryRoot,
    encoding: "utf8",
  });

try {
  const stagedPackageRoot = path.join(
    temporaryRoot,
    packageRoot,
  );
  await mkdir(path.join(stagedPackageRoot, "dist"), {
    recursive: true,
  });
  await copyFile(
    path.join(repositoryRoot, "index.cjs"),
    path.join(stagedPackageRoot, "index.cjs"),
  );
  await copyFile(
    path.join(repositoryRoot, "dist/index.mjs"),
    path.join(stagedPackageRoot, "dist/index.mjs"),
  );
  await writeFile(
    path.join(stagedPackageRoot, "package.json"),
    JSON.stringify({
      name: packageName,
      type: "module",
      exports: { ".": "./dist/index.mjs" },
    }),
  );

  let nativePackageCount = 0;
  const npmRoot = path.join(repositoryRoot, "npm");
  for (const directory of await readdir(npmRoot)) {
    const nativePackageJsonPath = path.join(
      npmRoot,
      directory,
      "package.json",
    );
    const nativePackageJson = JSON.parse(
      await readFile(nativePackageJsonPath, "utf8"),
    );
    const nativeMain = nativePackageJson.main;
    if (
      typeof nativeMain !== "string" ||
      !nativeMain.endsWith(".node")
    )
      continue;
    assert.equal(typeof nativePackageJson.name, "string");
    const nativePackageName = nativePackageJson.name;

    const packagedNativeBinary = path.join(
      npmRoot,
      directory,
      nativeMain,
    );
    const nativeBinary = (await Bun.file(
      packagedNativeBinary,
    ).exists())
      ? packagedNativeBinary
      : path.join(repositoryRoot, nativeMain);
    if (!(await Bun.file(nativeBinary).exists())) continue;

    const destination = path.join(
      temporaryRoot,
      "node_modules",
      ...nativePackageName.split("/"),
    );
    await mkdir(destination, { recursive: true });
    await copyFile(
      nativePackageJsonPath,
      path.join(destination, "package.json"),
    );
    await copyFile(
      nativeBinary,
      path.join(destination, nativeMain),
    );
    nativePackageCount++;
  }
  assert.ok(
    nativePackageCount > 0,
    "no built native platform package found",
  );

  const builtEntry = await readFile(
    path.join(repositoryRoot, "dist/index.mjs"),
    "utf8",
  );
  assert.match(
    builtEntry,
    /import\s+[^;]+from\s*["']\.\.\/index\.cjs["']/,
  );
  assert.doesNotMatch(builtEntry, /createRequire/);

  await writeFile(
    path.join(temporaryRoot, "probe.ts"),
    `import { AhoCorasick } from ${JSON.stringify(packageName)};\nconsole.log(JSON.stringify(new AhoCorasick(["foo"]).findIter("foo")));\n`,
  );
  const build = run("bun", [
    "build",
    "--compile",
    "probe.ts",
    "--outfile",
    "probe",
  ]);
  assert.equal(
    build.status,
    0,
    build.stderr || build.stdout,
  );

  await rm(path.join(temporaryRoot, "node_modules"), {
    recursive: true,
  });
  await rm(path.join(temporaryRoot, "probe.ts"));

  const probe = run("./probe", []);
  assert.equal(
    probe.status,
    0,
    probe.stderr || probe.stdout,
  );
  assert.equal(probe.stdout.trim(), expectedOutput);
  console.log("compiled smoke ok");
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
