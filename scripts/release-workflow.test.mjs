import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { extractWasmUploadGlobs } from "./release-artifact-layout.mjs";

const workflow = readFileSync(
  new URL(
    "../.github/workflows/release.yml",
    import.meta.url,
  ),
  "utf8",
);

const readJob = (name) => {
  const marker = `  ${name}:\n`;
  const start = workflow.indexOf(marker);
  expect(start).not.toBe(-1);

  const bodyStart = start + marker.length;
  const remainder = workflow.slice(bodyStart);
  const nextJob = remainder.search(
    /^  [A-Za-z_][A-Za-z0-9_-]*:\n/m,
  );
  return nextJob === -1
    ? workflow.slice(start)
    : workflow.slice(start, bodyStart + nextJob);
};

describe("release artifact layout", () => {
  test("extracts the exact WASM binding upload globs", () => {
    expect(extractWasmUploadGlobs(workflow)).toEqual([
      "*.wasm",
      "!*.debug.wasm",
      "!aho-corasick.single-thread.wasm",
      "*.cjs",
      "*.d.cts",
      "*.js",
      "*.mjs",
    ]);
  });

  test("rejects a renamed or duplicated WASM upload step", () => {
    expect(() =>
      extractWasmUploadGlobs(
        workflow.replace(
          "Upload WASM bindings",
          "Upload renamed WASM bindings",
        ),
      ),
    ).toThrow(
      "Expected exactly one Upload WASM bindings step, found 0",
    );
    expect(() =>
      extractWasmUploadGlobs(
        `${workflow}\n      - name: Upload WASM bindings\n`,
      ),
    ).toThrow(
      "Expected exactly one Upload WASM bindings step, found 2",
    );
  });

  test("downloads napi and single-thread artifacts separately", () => {
    for (const jobName of ["test", "pack"]) {
      const job = readJob(jobName);
      expect(job).toContain("pattern: bindings-*");
      expect(job).toContain("name: single-thread-wasm");
      expect(job).toContain("path: .");
    }
    expect(readJob("build")).toContain(
      "name: Upload single-thread WASM",
    );
  });
});

describe("Rust release recovery", () => {
  test("validates synchronized versions before every crate publish", () => {
    const verify = readJob("core-verify");
    const publish = readJob("core");
    const recovery = readJob("core-recovery");

    expect(verify).toContain(
      "node scripts/version-sync.mjs check",
    );
    expect(verify).toContain(
      "cargo package --locked --manifest-path crates/core/Cargo.toml",
    );
    expect(verify).toContain("github.event_name == 'push'");
    expect(publish).toMatch(
      /needs:\s*\[preflight, verify, test, pack, attest, core-verify\]/,
    );
    expect(publish).toContain(
      "needs.preflight.outputs.already-released != 'true'",
    );
    expect(publish).toContain(
      "needs.test.result == 'success'",
    );
    expect(publish).toContain(
      "needs.attest.result == 'success'",
    );
    expect(publish).toContain(
      "needs.core-verify.result == 'success'",
    );
    expect(recovery).toContain(
      "needs: [preflight, core-verify]",
    );
    expect(recovery).toContain(
      "needs.preflight.outputs.already-released == 'true'",
    );
    expect(recovery).toContain(
      "needs.core-verify.result == 'success'",
    );
    expect(publish).not.toMatch(
      /always\(\)|failure\(\)|cancelled\(\)/,
    );
    expect(recovery).not.toMatch(
      /always\(\)|failure\(\)|cancelled\(\)/,
    );
  });
});

describe("attested npm release recovery", () => {
  test("skips every build, test, pack, and attest path", () => {
    for (const jobName of [
      "verify",
      "build",
      "test",
      "pack",
      "attest",
      "core-verify",
      "core",
      "core-recovery",
    ]) {
      expect(readJob(jobName)).toContain(
        "inputs.recover_from_run == ''",
      );
    }
  });

  test("downloads, verifies, and re-uploads the source run artifacts", () => {
    const recover = readJob("recover");
    expect(recover).toContain(
      "run-id: ${{ inputs.recover_from_run }}",
    );
    expect(recover).toContain(
      "github-token: ${{ github.token }}",
    );
    expect(recover).toContain(
      "sha256sum --check --strict SHA256SUMS",
    );
    expect(recover).toContain(
      '--signer-workflow "${{ github.repository }}/.github/workflows/release.yml"',
    );
    expect(
      recover.indexOf("gh attestation verify"),
    ).toBeLessThan(
      recover.lastIndexOf("actions/upload-artifact@"),
    );
  });

  test("finalize accepts only successful recovery jobs in recovery mode", () => {
    const finalize = readJob("finalize");
    expect(finalize).toContain("recover, recover-core");
    expect(finalize).toContain(
      "needs.recover.result == 'success'",
    );
    expect(finalize).toContain(
      "needs.recover-core.result == 'success'",
    );
    expect(readJob("recover-core")).toContain(
      "needs: recover-core-check",
    );
    expect(readJob("recover-core-check")).toContain(
      "https://crates.io/api/v1/crates/",
    );
  });
});

test("privileged shared publishers match the release policy pin", () => {
  const expectedPin =
    "07debc754995bab35e446511859f1d93e1ad127a";
  const policy = readFileSync(
    new URL(
      "../.github/workflows/release-policy.yml",
      import.meta.url,
    ),
    "utf8",
  );
  const policyUse = policy.match(
    /uses: stella\/\.github\/\.github\/workflows\/release-policy\.yml@([0-9a-f]{40})/u,
  );
  const pin = policyUse?.at(1);
  if (pin === undefined)
    throw new Error("Missing immutable release policy pin");
  expect(pin).toBe(expectedPin);
  const publishers = [
    ...workflow.matchAll(
      /uses: stella\/\.github\/\.github\/workflows\/(?:crates-io-publish|npm-version-finalize)\.yml@([0-9a-f]{40})/gu,
    ),
  ];
  expect(publishers).toHaveLength(4);
  for (const publisher of publishers)
    expect(publisher.at(1)).toBe(expectedPin);
});
