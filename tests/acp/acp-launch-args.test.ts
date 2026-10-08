import { inspect } from "node:util";
import { expect, test } from "vitest";
import { antigravityAcpProfile } from "../../packages/oar/src/runtimes/antigravity/session.js";
import { grokAcpProfile } from "../../packages/oar/src/runtimes/grok/session.js";
import { kimiAcpProfile, kimiSession } from "../../packages/oar/src/runtimes/kimi/session.js";
import { opencodeAcpProfile } from "../../packages/oar/src/runtimes/opencode/session.js";
import { acpLaunchArgs } from "../../packages/oar/src/shared/acp/launch-args.js";

// SessionOptions.launchArgs on the ACP agents (oar#250): unchecked, where each CLI takes options.

test("ACP agents: after the subcommand by default; grok's go before `stdio`, where `agent` takes its options", () => {
  const launchArgs = ["--flag", "value"];
  expect(acpLaunchArgs(kimiAcpProfile, { cwd: "/work", launchArgs })).toEqual(["acp", "--flag", "value"]);
  expect(acpLaunchArgs(opencodeAcpProfile, { cwd: "/work", launchArgs })).toEqual(["acp", "--flag", "value"]);
  expect(acpLaunchArgs(grokAcpProfile, { cwd: "/work", launchArgs })).toEqual(["agent", "--always-approve", "--no-leader", "--flag", "value", "stdio"]);
  expect(acpLaunchArgs(antigravityAcpProfile, { cwd: "/work", launchArgs }).slice(-2)).toEqual(launchArgs);
});

test("omitted or empty launchArgs leave every argv as it was", () => {
  for (const profile of [kimiAcpProfile, opencodeAcpProfile, grokAcpProfile]) {
    const plain = acpLaunchArgs(profile, { cwd: "/work" });
    expect(acpLaunchArgs(profile, { cwd: "/work", launchArgs: [] })).toEqual(plain);
  }
});

// Node's spawn error carries the whole argv in `spawnargs`; a host that logs
// the rejection must not print the launch arguments (Lookout, #251).
test("a runtime that cannot start rejects with no launch argument in the error", async () => {
  const secret = "LAUNCH-SECRET-123";
  const failure: unknown = await kimiSession({ kind: "available", via: "executable", command: "/nonexistent/oar-runtime" }, { cwd: "/tmp", launchArgs: [`--token=${secret}`] }).catch((error: unknown) => error);
  expect(failure).toMatchObject({ code: "ENOENT" });
  expect([inspect(failure, { depth: 5 }), JSON.stringify(failure)].filter((text) => text.includes(secret))).toEqual([]);
});

test("an argument Node cannot pass (a NUL byte) is not quoted in the error either", async () => {
  const secret = "LAUNCH-SECRET-456";
  const failure: unknown = await kimiSession({ kind: "available", via: "executable", command: process.execPath }, { cwd: "/tmp", launchArgs: [`--token=${secret}\0x`] }).catch((error: unknown) => error);
  expect(failure).toMatchObject({ code: "ERR_INVALID_ARG_VALUE" });
  expect([inspect(failure, { depth: 5 }), JSON.stringify(failure)].filter((text) => text.includes(secret))).toEqual([]);
});
