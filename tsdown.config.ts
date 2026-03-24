import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/lib.ts"],
  format: ["esm", "cjs"],
  dts: { resolve: true, autoAddExts: true },
  clean: true,
  sourcemap: true,
  external: [/\.\/index\.js/, /\.\.\/index\.js/],
  hash: false,
});
