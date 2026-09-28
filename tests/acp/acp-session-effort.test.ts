import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { acpReportedEffort, acpThoughtLevelOption } from "../../packages/oar/src/shared/acp/model.js";
import { describe, fixture, start } from "../fixtures/acp-session-support.js";

// The effort channel on ACP is the agent's `thought_level` config option,
// found by category (grok 1.0.41 `reasoning_effort`, kimi 2.0.0 `thinking`;
// the fixture's `fixture_effort`), set with session/set_config_option and read
// back from the answer's current value.

test("the opening answers report the agent's effort, so effort() is a fold even when none was requested", async () => {
  const session = await start();
  const opening = session.records().map((record) => describe(record));
  assert.equal(opening[2], "event session/new → model:fixture-model-x, effort:medium");
  assert.equal(session.effort().value, "medium");
  await session.dispose();
});

test("a requested effort is set through the thought_level option and read back from the agent's answer", async () => {
  const session = await start({}, undefined, undefined, "high");
  const opening = session.records().map((record) => describe(record));
  // kimi-style: the agent pushes the update before it answers; both are its word.
  assert.ok(opening.includes("event config_option_update → model:fixture-model-x, effort:high"), JSON.stringify(opening));
  assert.ok(opening.includes("event session/set_config_option → model:fixture-model-x, effort:high"), JSON.stringify(opening));
  assert.equal(session.effort().value, "high");
  const answer = session.records().find((record) => record.kind === "frame" && record.body.type === "session/set_config_option");
  assert.ok(answer?.kind === "frame");
  expect(answer.body.native).toMatchObject({ configOptions: [{ id: "model" }, { id: "fixture_effort", currentValue: "high" }] });
  await session.dispose();
});

test("a resumed session takes the requested effort too", async () => {
  const session = await start({}, "fake-session", undefined, "low");
  assert.equal(session.id, "fake-session");
  assert.equal(session.effort().value, "low");
  await session.dispose();
});

test.each([
  { name: "the agent refuses the level", mode: "session", effort: "bogus", message: "session/set_config_option fixture_effort=bogus was refused: Invalid params (unknown fixture_effort value)" },
  { name: "the agent applies another level", mode: "session", effort: "sticky", message: "session/set_config_option left fixture_effort at medium although effort sticky was requested" },
  { name: "the agent offers no thought_level option", mode: "no-thought-level", effort: "high", message: "session/new advertises no thought_level config option, so effort high cannot be applied" },
])("the open is refused when $name", async ({ mode, effort, message }) => {
  await expect(start({ args: [fixture, mode] }, undefined, undefined, effort)).rejects.toThrow(message);
});

test("acpThoughtLevelOption finds the effort selector by category, whatever its id", () => {
  const configOptions = [
    { id: "model", category: "model", currentValue: "k3" },
    { id: "thinking", category: "thought_level", currentValue: "high" },
    { id: "mode", category: "mode", currentValue: "yolo" },
  ];
  expect(acpThoughtLevelOption({ configOptions })?.id).toBe("thinking");
  expect(acpReportedEffort({ configOptions })).toBe("high");
  expect(acpReportedEffort({ configOptions: [{ id: "thinking", currentValue: "high" }] })).toBeNull();
  expect(acpReportedEffort(null)).toBeNull();
});
