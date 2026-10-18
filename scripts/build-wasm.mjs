import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const run = (script, args = []) => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL(script, import.meta.url)),
      ...args,
    ],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run("./build-single-thread.mjs");
run("./build-native.mjs", [
  "--platform",
  "--target",
  "wasm32-wasip1-threads",
  "--dts",
  "index.d.cts",
  "--release",
]);
