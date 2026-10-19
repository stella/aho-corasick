import { describe, expect, test } from "bun:test";
import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";

const workflow = readFileSync(
  new URL(
    "../.github/workflows/release.yml",
    import.meta.url,
  ),
  "utf8",
);

const sharedReference =
  /stella\/\.github\/[^\s"']+?@([A-Za-z0-9._/-]+)/gu;

const sharedRevisions = (contents) => {
  const revisions = [
    ...contents.matchAll(sharedReference),
  ].map((match) => match.at(1));
  if (revisions.length === 0)
    throw new Error("Missing stella/.github reference");
  if (
    !revisions.every((revision) =>
      /^[0-9a-f]{40}$/u.test(revision),
    )
  )
    throw new Error(
      "Shared references must use full commit SHAs",
    );
  if (new Set(revisions).size !== 1)
    throw new Error(
      "Shared references must use one revision",
    );
  return revisions.at(0);
};

const filesBelow = (directory) => {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      readFileSync(
        `${entry.parentPath}/${entry.name}`,
        "utf8",
      ),
    );
};

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

test("all shared workflow and action references use one immutable revision", () => {
  const github = new URL("../.github/", import.meta.url);
  const contents = [
    ...filesBelow(new URL("workflows/", github)),
    ...filesBelow(new URL("actions/", github)),
  ].join("\n");
  expect(sharedRevisions(contents)).toMatch(
    /^[0-9a-f]{40}$/u,
  );
});

test("shared reference validation rejects tags beside pinned references", () => {
  const pin = "0123456789abcdef0123456789abcdef01234567";
  for (const mutable of ["main", "v1.2.3"]) {
    const fixture = [
      `uses: stella/.github/.github/workflows/ci.yml@${pin}`,
      `uses: "stella/.github/.github/actions/check@${mutable}"`,
    ].join("\n");
    expect(() => sharedRevisions(fixture)).toThrow(
      "Shared references must use full commit SHAs",
    );
  }
});
