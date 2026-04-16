/* Vite plugin that wires up @stll/aho-corasick-wasm so its napi-rs-generated
 * wasm loader survives Vite's dep pre-bundler. Excludes the browser entry
 * and sibling wasm package from pre-bundling and SSR externalization so
 * relative asset URLs keep working. */
import type { Plugin, UserConfig } from "vite";

export const WASM_VITE_PACKAGES = [
  "@stll/aho-corasick-wasm",
  "@stll/aho-corasick-wasm32-wasi",
] as const;

function mergeStrings(
  existing: string[] | undefined,
  additions: readonly string[],
): string[] {
  return [...new Set([...(existing ?? []), ...additions])];
}

export function buildAhoCorasickWasmViteConfig(
  config: UserConfig = {},
): UserConfig {
  return {
    ...config,
    optimizeDeps: {
      ...config.optimizeDeps,
      exclude: mergeStrings(config.optimizeDeps?.exclude, WASM_VITE_PACKAGES),
    },
    ssr: {
      ...config.ssr,
      external:
        config.ssr?.external === true
          ? true
          : mergeStrings(config.ssr?.external, WASM_VITE_PACKAGES),
    },
  };
}

export default function stllAhoCorasickWasmVite(): Plugin {
  return {
    name: "stll-aho-corasick-wasm",
    config() {
      return {
        optimizeDeps: {
          exclude: [...WASM_VITE_PACKAGES],
        },
        ssr: {
          external: [...WASM_VITE_PACKAGES],
        },
      };
    },
  };
}
