import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL(
    "../.github/workflows/release.yml",
    import.meta.url,
  ),
  "utf8",
);

const jobsStart = workflow.indexOf("\njobs:\n");
expect(jobsStart).not.toBe(-1);
const jobsText = workflow.slice(
  jobsStart + "\njobs:\n".length,
);
const headers = [
  ...jobsText.matchAll(
    /^  ([A-Za-z_][A-Za-z0-9_-]*):\s*$/gm,
  ),
];
const jobs = new Map(
  headers.map((header, index) => [
    header[1],
    jobsText.slice(
      header.index,
      headers.at(index + 1)?.index ?? jobsText.length,
    ),
  ]),
);

const job = (name) => {
  const body = jobs.get(name);
  expect(body, `missing ${name} job`).toBeDefined();
  return body;
};

describe("release credential boundaries", () => {
  test("only the artifact consumers receive OIDC", () => {
    const oidcJobs = [...jobs]
      .filter(([, body]) => /id-token:\s*write/.test(body))
      .map(([name]) => name)
      .sort((left, right) => left.localeCompare(right));

    expect(oidcJobs).toEqual([
      "attest",
      "core",
      "finalize",
    ]);
  });

  test("builds and packs npm artifacts without OIDC", () => {
    const pack = job("pack");
    expect(pack).not.toContain("id-token: write");
    expect(pack).not.toContain("attestations: write");
    expect(pack).not.toContain("actions/attest@");
    expect(pack).toContain(
      "npm pack --json --ignore-scripts",
    );
  });

  test("attests only downloaded npm artifacts with OIDC", () => {
    const attest = job("attest");
    expect(attest).toContain("id-token: write");
    expect(attest).toContain("actions/download-artifact@");
    expect(attest).toContain("actions/attest@");
    expect(attest).not.toMatch(
      /actions\/checkout@|setup-bun@|npm (?:install|pack)|bun (?:install|run)|cargo /,
    );
  });

  test("packages the Rust crate without OIDC", () => {
    const corePackage = job("core-package");
    expect(corePackage).not.toContain("id-token: write");
    expect(corePackage).toContain(
      "cargo package --package stella-aho-corasick-core --locked",
    );
  });

  test("publishes only the prebuilt Rust upload body with OIDC", () => {
    const core = job("core");
    expect(core).toContain("id-token: write");
    expect(core).toContain("actions/download-artifact@");
    expect(core).toContain("--data-binary");
    expect(core).toContain(
      "The ambiguous upload committed ${CRATE_NAME} ${CRATE_VERSION}",
    );
    expect(core).not.toMatch(
      /actions\/checkout@|setup-bun@|rust-toolchain@|npm (?:install|pack)|bun (?:install|run)|cargo (?:package|publish|build|test)/,
    );
  });
});
