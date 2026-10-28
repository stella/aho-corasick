import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { extractWasmUploadGlobs } from "./release-artifact-layout.mjs";

const workflow = readFileSync(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8",
);

const readJob = (name) => {
  const marker = `  ${name}:\n`;
  const start = workflow.indexOf(marker);
  expect(start).not.toBe(-1);

  const bodyStart = start + marker.length;
  const remainder = workflow.slice(bodyStart);
  const nextJob = remainder.search(/^  [A-Za-z_][A-Za-z0-9_-]*:\n/m);
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
    ).toThrow("Expected exactly one Upload WASM bindings step, found 0");
    expect(() =>
      extractWasmUploadGlobs(
        `${workflow}\n      - name: Upload WASM bindings\n`,
      ),
    ).toThrow("Expected exactly one Upload WASM bindings step, found 2");
  });

  test("downloads napi and single-thread artifacts separately", () => {
    for (const jobName of ["test", "pack"]) {
      const job = readJob(jobName);
      expect(job).toContain("pattern: bindings-*");
      expect(job).toContain("name: single-thread-wasm");
      expect(job).toContain("path: .");
    }
    expect(readJob("build")).toContain("name: Upload single-thread WASM");
  });
});

describe("Rust release recovery", () => {
  test("validates synchronized versions before every crate publish", () => {
    const verify = readJob("core-verify");
    const publish = readJob("core");
    const recovery = readJob("core-recovery");

    expect(verify).toContain("node scripts/version-sync.mjs check");
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
    expect(publish).toContain("needs.test.result == 'success'");
    expect(publish).toContain("needs.attest.result == 'success'");
    expect(publish).toContain("needs.core-verify.result == 'success'");
    expect(recovery).toContain("needs: [preflight, core-verify]");
    expect(recovery).toContain(
      "needs.preflight.outputs.already-released == 'true'",
    );
    expect(recovery).toContain("needs.core-verify.result == 'success'");
    expect(publish).not.toMatch(/always\(\)|failure\(\)|cancelled\(\)/);
    expect(recovery).not.toMatch(/always\(\)|failure\(\)|cancelled\(\)/);
  });
});

describe("attested npm release recovery", () => {
  test("skips every build, test, pack, and attest path", () => {
    for (const jobName of [
      "preflight",
      "verify",
      "build",
      "test",
      "pack",
      "core-verify",
    ]) {
      expect(readJob(jobName)).toContain("inputs.recover_from_run == ''");
    }
    // Privileged jobs keep the release policy's leading main-ref guard and
    // are skipped in recovery through a gated dependency instead.
    for (const [jobName, gatedDependency] of [
      ["attest", "pack"],
      ["core", "preflight"],
      ["core-recovery", "preflight"],
    ]) {
      const job = readJob(jobName);
      expect(job).toContain("github.ref == 'refs/heads/main' && (");
      expect(job).not.toContain("inputs.recover_from_run");
      expect(job).toMatch(
        new RegExp(
          `needs:\\s*(?:${gatedDependency}\\b|\\[[^\\]]*\\b${gatedDependency}\\b)`,
          "u",
        ),
      );
    }
  });

  test("downloads, verifies, and re-uploads the source run artifacts", () => {
    const recover = readJob("recover");
    expect(recover).toContain("run-id: ${{ inputs.recover_from_run }}");
    expect(recover).toContain("github-token: ${{ github.token }}");
    expect(recover).toContain("sha256sum --check --strict SHA256SUMS");
    expect(recover).toContain(
      '--signer-workflow "${{ github.repository }}/.github/workflows/release.yml"',
    );
    // The attest job signs a CycloneDX SBOM (sbom-path), not SLSA provenance,
    // so recovery must verify that predicate or it refuses valid tarballs.
    expect(readJob("attest")).toContain("sbom-path:");
    expect(recover).toContain("--predicate-type https://cyclonedx.org/bom");
    expect(recover.indexOf("gh attestation verify")).toBeLessThan(
      recover.lastIndexOf("actions/upload-artifact@"),
    );
  });

  test("finalize accepts only successful recovery jobs in recovery mode", () => {
    // Recovery has its own finalizer: the normal one stays success-gated on
    // build jobs that recovery skips, and the policy bans status functions.
    expect(readJob("finalize")).not.toContain("recover");
    const finalize = readJob("finalize-recovery");
    expect(finalize).toContain("needs: [recover, recover-core-check]");
    expect(finalize).toContain("inputs.recover_from_run != ''");
    expect(finalize).not.toMatch(
      /\b(?:always|success|failure|cancelled)\s*\(/u,
    );
    const coreCheck = readJob("recover-core-check");
    expect(coreCheck).toContain("https://crates.io/api/v1/crates/");
    // Recovery never packages or publishes the crate, so it gains no
    // publishing credential.
    for (const job of ["recovery-ref", "recover", "recover-core-check"]) {
      expect(readJob(job)).not.toContain("id-token: write");
      expect(readJob(job)).not.toContain("crates-io-publish.yml");
    }
  });
});

test("privileged shared publishers match the release policy pin", () => {
  const policy = readFileSync(
    new URL("../.github/workflows/release-policy.yml", import.meta.url),
    "utf8",
  );
  const policyUse = policy.match(
    /uses: stella\/\.github\/\.github\/workflows\/release-policy\.yml@([0-9a-f]{40})/u,
  );
  const pin = policyUse?.at(1);
  if (pin === undefined)
    throw new Error("Missing immutable release policy pin");
  const publishers = [
    ...workflow.matchAll(
      /uses: stella\/\.github\/\.github\/workflows\/(?:crates-io-publish|npm-version-finalize)\.yml@([0-9a-f]{40})/gu,
    ),
  ];
  expect(publishers).toHaveLength(4);
  for (const publisher of publishers) expect(publisher.at(1)).toBe(pin);
});
