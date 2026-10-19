import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

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

test("privileged shared publishers match the release policy pin", () => {
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
  const publishers = [
    ...workflow.matchAll(
      /uses: stella\/\.github\/\.github\/workflows\/(?:crates-io-publish|npm-version-finalize)\.yml@([0-9a-f]{40})/gu,
    ),
  ];
  expect(publishers).toHaveLength(3);
  for (const publisher of publishers)
    expect(publisher.at(1)).toBe(pin);
});

test("all shared workflows and actions use one immutable revision", () => {
  const github = new URL("../.github/", import.meta.url);
  const files = ["workflows", "actions"]
    .filter((directory) =>
      existsSync(new URL(directory, github)),
    )
    .flatMap((directory) =>
      [
        ...new Bun.Glob("**/*.{yml,yaml}").scanSync({
          cwd: new URL(directory, github).pathname,
          onlyFiles: true,
        }),
      ].map(
        (file) => new URL(`${directory}/${file}`, github),
      ),
    );
  const pins = files.flatMap((file) =>
    Array.from(
      readFileSync(file, "utf8").matchAll(
        /uses: stella\/\.github\/[^@\s]+@([0-9a-f]{40})/gu,
      ),
      (match) => match.at(1),
    ),
  );

  expect(pins.length).toBeGreaterThan(0);
  expect(new Set(pins)).toEqual(
    new Set(["8f19eb7220047e5b06f6e75f0b9f908bfd01f5f6"]),
  );
});
