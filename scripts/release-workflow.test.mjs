import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

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
  return nextJob === -1 ? workflow.slice(start) : workflow.slice(start, bodyStart + nextJob);
};

describe("Rust release recovery", () => {
  test("validates synchronized versions before every crate publish", () => {
    const verify = readJob("core-verify");
    const publish = readJob("core");
    const recovery = readJob("core-recovery");

    expect(verify).toContain("node scripts/version-sync.mjs check");
    expect(verify).toContain("cargo package --locked --manifest-path crates/core/Cargo.toml");
    expect(verify).toContain("github.event_name == 'push'");
    expect(publish).toContain("needs: [preflight, verify, test, pack, attest, core-verify]");
    expect(publish).toContain("needs.preflight.outputs.already-released != 'true'");
    expect(publish).toContain("needs.test.result == 'success'");
    expect(publish).toContain("needs.attest.result == 'success'");
    expect(publish).toContain("needs.core-verify.result == 'success'");
    expect(recovery).toContain("needs: [preflight, core-verify]");
    expect(recovery).toContain("needs.preflight.outputs.already-released == 'true'");
    expect(recovery).toContain("needs.core-verify.result == 'success'");
    expect(publish).not.toMatch(/always\(\)|failure\(\)|cancelled\(\)/);
    expect(recovery).not.toMatch(/always\(\)|failure\(\)|cancelled\(\)/);
  });
});
