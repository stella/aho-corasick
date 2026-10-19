import assert from "node:assert/strict";
import { test } from "node:test";

import { engineSupportDecision } from "./check-engine-support.mjs";

const decide = ({
  baseRange = ">=18",
  headRange = ">=18",
  releaseType,
} = {}) =>
  engineSupportDecision({
    packageName: "fixture",
    baseRange,
    headRange,
    releaseType,
  });

void test("unchanged support needs no pending changeset", () => {
  assert.deepEqual(decide(), {
    allowed: true,
    supportReduced: false,
  });
});

void test("reduced support rejects a minor changeset", () => {
  assert.deepEqual(
    decide({ headRange: ">=20", releaseType: "minor" }),
    {
      allowed: false,
      supportReduced: true,
      reason:
        "fixture reduces engines.node support and requires a major changeset",
    },
  );
});

void test("reduced support accepts a major changeset", () => {
  assert.deepEqual(
    decide({ headRange: ">=20", releaseType: "major" }),
    {
      allowed: true,
      supportReduced: true,
    },
  );
});

void test("wider support needs no pending changeset", () => {
  assert.deepEqual(
    decide({ baseRange: ">=20", headRange: ">=18" }),
    {
      allowed: true,
      supportReduced: false,
    },
  );
});
