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

    expect(verify).toContain("node scripts/version-sync.mjs check");
    expect(verify).toContain("cargo package --locked --manifest-path crates/core/Cargo.toml");
    expect(verify).toContain("github.event_name == 'push'");
    expect(publish).toContain("needs: [preflight, core-verify]");
    expect(publish).toContain("needs.core-verify.result == 'success'");
    expect(publish).not.toMatch(/always\(\)|failure\(\)|cancelled\(\)/);
    expect(publish).not.toContain("always()");
  });
});
