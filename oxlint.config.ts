import { library } from "@stll/oxlint-config";
import {
  portableSafetyPluginSpecifiers,
  portableSafetyRules,
} from "@stll/oxlint-plugin";
import type { OxlintConfig } from "oxlint";

const config: OxlintConfig = library({
  // NAPI CLI outputs; scripts/build-native.mjs and fix-napi-loader.mjs own these artifacts.
  ignorePatterns: [
    "*.node",
    "npm/",
    "index.cjs",
    "index.d.cts",
    "*.wasi.cjs",
    "*.wasi-browser.js",
    "browser.js",
    "wasi-worker.mjs",
    "wasi-worker-browser.mjs",
  ],
  jsPlugins: [...portableSafetyPluginSpecifiers],
  rules: { ...portableSafetyRules },
});

export default config;
