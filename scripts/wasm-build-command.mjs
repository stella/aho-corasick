const expectedCommands = {
  build:
    "node scripts/build-native.mjs --platform --dts index.d.cts --release",
  "build:debug":
    "node scripts/build-native.mjs --platform --dts index.d.cts",
  "build:wasm": "node scripts/build-wasm.mjs",
};

/** @param {Record<string, unknown>} scripts */
export const validateWasmBuildCommands = (scripts) => {
  for (const [scriptName, expected] of Object.entries(
    expectedCommands,
  )) {
    if (scripts[scriptName] !== expected) {
      throw new Error(
        `${scriptName} must be exactly ${expected}`,
      );
    }
  }
};
