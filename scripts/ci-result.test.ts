import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const readWorkflow = (name: string): Record<string, unknown> => {
  const value: unknown = Bun.YAML.parse(
    readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"),
  );
  if (!record(value)) throw new Error(`Invalid workflow ${name}`);
  return value;
};
const workflow = readWorkflow("ci");
const jobs = workflow["jobs"];
if (!record(jobs)) throw new Error("Missing CI jobs");
const gate = jobs["ci-result"];
if (!record(gate) || !Array.isArray(gate["steps"])) throw new Error("Missing gate");
const rejectStep = gate["steps"].find((value: unknown) => record(value) && value["name"] === "Reject untrusted pull requests");
if (!record(rejectStep)) throw new Error("Missing untrusted pull request rejection");
const step = gate["steps"].find((value: unknown) => record(value) && value["name"] === "Require every selected validation job");
if (!record(step) || !record(step["env"]) || typeof step["run"] !== "string") throw new Error("Missing verdict");
const run = step["run"];
const env = step["env"];
const resultVariables = Object.entries(env).flatMap(([name, expression]) => {
  const job = typeof expression === "string"
    ? /^\$\{\{ needs\.([\w-]+)\.result \}\}$/u.exec(expression)?.at(1)
    : undefined;
  return job === undefined ? [] : [{ name, job }];
});

test("the always-running gate covers every caller job and its complete reusable result", () => {
  expect(gate["if"]).toBe("always()");
  const otherJobs = Object.keys(jobs).filter((name) => name !== "ci-result");
  const dependencies = gate["needs"];
  if (!Array.isArray(dependencies) || !dependencies.every((value: unknown) => typeof value === "string")) throw new Error("Invalid gate dependencies");
  expect(dependencies).toContain("trust-check");
  expect(new Set(dependencies)).toEqual(new Set(otherJobs));
  expect(new Set(resultVariables.map(({ job }) => job))).toEqual(new Set(otherJobs));
  expect(env["EVENT_NAME"]).toBe("${{ github.event_name }}");
  expect(env["TRUSTED"]).toBe("${{ needs.trust-check.outputs.trusted }}");
  expect(env["RUST_CHANGED"]).toBe("${{ needs.check-changes.outputs.rust-changed }}");
  expect(String(rejectStep["if"]).trim().replace(/\s+/gu, " ")).toBe(
    "github.event_name == 'pull_request' && needs.trust-check.outputs.trusted != 'true'",
  );
  expect(rejectStep["run"]).toBe("exit 1");
  expect(String(step["if"]).trim().replace(/\s+/gu, " ")).toBe(
    "github.event_name != 'pull_request' || needs.trust-check.outputs.trusted == 'true'",
  );
});

test("the actual verdict rejects every failure, cancellation, and unselected skip", () => {
  type VerdictCase = { event: string; changedJob?: string; result?: string; rust?: string; trusted?: string };
  const evaluate = ({ event, changedJob, result = "success", rust = "true", trusted = "true" }: VerdictCase) =>
    Bun.spawnSync(["/bin/bash", "-eu", "-c", run], {
      env: {
        EVENT_NAME: event, RUST_CHANGED: rust, TRUSTED: trusted,
        ...Object.fromEntries(resultVariables.map(({ name, job }) => {
          if (job === changedJob) return [name, result];
          const eventOnlySkip = event !== "pull_request" && ["trust-check", "changeset"].includes(job);
          return [name, eventOnlySkip ? "skipped" : "success"];
        })),
      },
      stdout: "pipe", stderr: "pipe",
    }).exitCode;
  for (const event of ["pull_request", "merge_group", "push", "workflow_dispatch"]) {
    expect(evaluate({ event })).toBe(0);
    for (const { job } of resultVariables) {
      for (const result of ["failure", "cancelled", "skipped", "unexpected", ""]) {
        const eventSkip = event !== "pull_request" && ["trust-check", "changeset"].includes(job) && result === "skipped";
        expect(evaluate({ event, changedJob: job, result }) === 0, `${event}: ${job}: ${result}`).toBe(eventSkip);
      }
    }
    expect(evaluate({ event, changedJob: "hawk", result: "skipped", rust: "false" })).toBe(0);
    expect(evaluate({ event, changedJob: "hawk", result: "cancelled", rust: "false" })).not.toBe(0);
    expect(evaluate({ event, changedJob: "hawk", result: "skipped", rust: "" })).not.toBe(0);
  }
  for (const trusted of ["false", ""]) expect(evaluate({ event: "pull_request", trusted })).not.toBe(0);
});

test("CI and CLA handle merge groups with the immutable merged base and verifier", () => {
  const triggers = workflow["on"];
  if (!record(triggers)) throw new Error("Missing CI triggers");
  expect(triggers["merge_group"]).toEqual({ types: ["checks_requested"] });
  const detector = jobs["check-changes"];
  if (!record(detector) || !Array.isArray(detector["steps"])) throw new Error("Missing detector steps");
  const toolchain = detector["steps"].find((value: unknown) => record(value) && value["id"] === "toolchain");
  if (!record(toolchain) || !record(toolchain["env"])) throw new Error("Missing toolchain base");
  expect(toolchain["env"]["BASE_REF"]).toContain("github.event.merge_group.base_sha");
  const filter = detector["steps"].find((value: unknown) => record(value) && value["id"] === "filter");
  if (!record(filter) || !record(filter["with"])) throw new Error("Missing path filter");
  expect(filter["with"]["base"]).toBe("${{ github.event.merge_group.base_sha || github.event.repository.default_branch }}");
  const cla = readWorkflow("cla");
  if (!record(cla["on"]) || !record(cla["jobs"]) || !record(cla["jobs"]["cla"])) throw new Error("Missing CLA contract");
  expect(cla["on"]["merge_group"]).toEqual({ types: ["checks_requested"] });
  expect(cla["jobs"]["cla"]["uses"]).toBe("stella/.github/.github/workflows/cla.yml@caa3ee1c2d02ef807994fdd3907c55ba104aff00");
  expect(cla["jobs"]["cla"]["if"]).toContain("github.event_name == 'merge_group'");
  expect(cla["permissions"]).toEqual({ contents: "read", issues: "write", "pull-requests": "read", checks: "write" });
});
