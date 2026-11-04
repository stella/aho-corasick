#!/usr/bin/env bash
# Compare the full config import with one that stubs the tsdown specifier.
set -u
order=$1
url="file://$PWD/tsdown.config.ts"
full='await import(process.argv[1]);'
stub='import { registerHooks } from "node:module"; registerHooks({ resolve: (specifier, context, nextResolve) => specifier === "tsdown" ? { shortCircuit: true, url: "data:text/javascript,export const defineConfig = (config) => config;" } : nextResolve(specifier, context) }); const { default: config } = await import(process.argv[1]); if (!Array.isArray(config)) throw new Error("no build list");'
run() {
  local label=$1 code=$2 t0 t1 status
  t0=$(date +%s%N)
  node --input-type=module -e "$code" "$url" </dev/null >/dev/null 2>/tmp/err; status=$?
  t1=$(date +%s%N)
  echo "$label status=$status ms=$(( (t1 - t0) / 1000000 )) $(head -c 200 /tmp/err)"
}
drop() { sync; sudo sh -c 'echo 3 >/proc/sys/vm/drop_caches'; }
if [ "$order" = stub-first ]; then run first-stub "$stub"; run second-full "$full"; else run first-full "$full"; run second-stub "$stub"; fi
for i in $(seq 1 30); do drop; run cold-full "$full"; drop; run cold-stub "$stub"; done
for i in $(seq 1 30); do run warm-full "$full"; run warm-stub "$stub"; done
