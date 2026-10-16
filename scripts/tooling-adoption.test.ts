import { library } from "@stll/oxlint-config";
import {
  portableSafetyPluginSpecifiers,
  portableSafetyRules,
} from "@stll/oxlint-plugin";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import config from "../oxlint.config";

test("the shared portable safety pack stays active in every preset scope", () => {
  expect(config.jsPlugins).toEqual(
    expect.arrayContaining(portableSafetyPluginSpecifiers),
  );
  for (const [rule, severity] of Object.entries(
    portableSafetyRules,
  )) {
    expect(config.rules?.[rule]).toBe(severity);
    for (const override of config.overrides ?? []) {
      expect(
        override.rules?.[rule] ?? config.rules?.[rule],
      ).toBe(severity);
    }
  }
  expect(config.overrides).toEqual(
    library({ rules: { ...portableSafetyRules } })
      .overrides,
  );
});

test("cloud outputs match the installed shared generator", () => {
  const root = new URL("../", import.meta.url);
  const fixture = mkdtempSync(
    join(tmpdir(), "aho cloud-ž-"),
  );
  const run = (command: string, args: string[]) => {
    const result = spawnSync(command, args, {
      cwd: fixture,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  };
  try {
    for (const file of [
      "package.json",
      "bun.lock",
      "stll-toolchain.json",
      ".node-version",
    ]) {
      writeFileSync(
        join(fixture, file),
        readFileSync(new URL(file, root)),
      );
    }
    mkdirSync(join(fixture, ".claude"));
    writeFileSync(
      join(fixture, ".claude/settings.json"),
      readFileSync(new URL(".claude/settings.json", root)),
    );
    run("git", ["init", "--quiet"]);
    run("git", ["add", "--", "."]);
    symlinkSync(
      fileURLToPath(new URL("node_modules", root)),
      join(fixture, "node_modules"),
      "dir",
    );
    run("bun", [
      fileURLToPath(
        pathToFileURL(
          join(
            fixture,
            "node_modules/@stll/oxlint-config/dist/cloud-setup-cli.mjs",
          ),
        ),
      ),
    ]);
    for (const file of [
      ".agents/cloud-setup.sh",
      ".claude/settings.json",
    ]) {
      expect(
        readFileSync(join(fixture, file), "utf8"),
      ).toBe(readFileSync(new URL(file, root), "utf8"));
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
