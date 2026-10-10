import { expect, test } from "vitest";
import { promptAndWait, usageOf, viewOf } from "../../packages/oar/src/observe/index.js";
import { grokAcpProfile } from "../../packages/oar/src/runtimes/grok/session.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { fixture, profile, start } from "../fixtures/acp-session-support.js";

test.each([
  { scenario: "foreground", input: 2810, output: 31, wakes: 0 },
  { scenario: "background-child-first", input: 2820, output: 32, wakes: 2 },
  { scenario: "background-parent-first", input: 2120, output: 25, wakes: 2 },
// oxlint-disable-next-line eslint/max-statements -- Compare live, duplicated native frames and JSON replay for one recorded scenario.
])("Grok recorded $scenario counts root wakes once without guessing child inclusion", async ({ scenario, input, output, wakes }) => {
  const session = await start({ ...grokAcpProfile, ...profile() });
  try {
    await promptAndWait(session, `grok-${scenario}`);
    await promptAndWait(session, `grok-${scenario}`);
    const usage = { total: { input, output, cacheRead: 0, cacheWrite: 0 } };
    expect(session.usage().value).toEqual(usage);
    const records = session.records();
    const wakeFrames = records.filter((record) => {
      const update = record.kind === "frame" ? asRecord(asRecord(record.body.native)?.update) : null;
      return typeof update?.prompt_id === "string" && update.prompt_id.startsWith("subagent-completed-");
    });
    expect(wakeFrames).toHaveLength(wakes);
    expect(wakeFrames.flatMap((record) => record.kind === "frame" ? record.body.events : [])).toHaveLength(wakes / 2);
    // oxlint-disable-next-line typescript/no-unsafe-assignment, unicorn/prefer-structured-clone -- JSON retention is the host's replay boundary.
    const restored: typeof records = JSON.parse(JSON.stringify(records));
    expect(usageOf(restored, session.id)).toEqual(session.usage());
    expect(viewOf(restored).usage).toEqual(usage);
  } finally {
    await session.dispose();
  }
});

// oxlint-disable-next-line eslint/max-statements -- Historical replay, opening boundary and subsequent live bills in one process.
test.each(["load", "resume"])("historical wake replay during session/%s stays native-only", async (method) => {
  const session = await start({ ...grokAcpProfile, ...profile({ args: [fixture, `grok-usage-${method}`] }) }, "fake-session");
  try {
    const opened = session.records().find((record) => record.kind === "frame" && record.body.type === `session/${method}`);
    expect(opened).toBeDefined();
    expect(session.usage().value).toEqual({ total: null });
    const historical = session.records().find((record) => record.kind === "frame" && record.body.type === "_x.ai/session_notification");
    expect(historical).toMatchObject({ kind: "frame", body: { events: [] } });
    await promptAndWait(session, "grok-background-parent-first");
    await promptAndWait(session, "grok-background-parent-first");
    expect(session.usage().value).toEqual({ total: { input: 2120, output: 25, cacheRead: 0, cacheWrite: 0 } });
  } finally {
    await session.dispose();
  }
});
