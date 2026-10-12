/* oxlint-disable max-statements, no-underscore-dangle -- Pin the entire prompt/steer/queue handoff and its native ACP _meta fields. */
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { grokAcpProfile } from "../../packages/oar/src/runtimes/grok/session.js";
import { grokPromptOutcome } from "../../packages/oar/src/runtimes/grok/failure.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { awaitTurnEnd, promptAndWait, turnEndAfter, viewOf } from "../../packages/oar/src/observe/index.js";
import { profile, start } from "../fixtures/acp-session-support.js";

// Grok 1.0.50 + aimock, 2026-10-11. Native replies; session and prompt ids removed.
function reply(mode: string) {
  const text = readFileSync(new URL(`../replay/fixtures/grok-structured-output-${mode}.raw.jsonl`, import.meta.url), "utf8");
  return asRecord(parseJson(text)) ?? {};
}

test.each(["valid", "invalid", "bad-schema"])("Grok native %s result has the same outcome live and after JSON retention", async (mode) => {
  const native = reply(mode);
  const outcome = grokPromptOutcome(native);
  expect(outcome.kind).toBe(mode === "valid" ? "completed" : "failed");
  if (mode === "valid") { expect(outcome).toEqual({ kind: "completed", structuredOutput: { answer: 4 } }); }
  else { expect(outcome).toMatchObject({ failure: "output_schema", reason: asRecord(native._meta)?.structuredOutputError }); }
  const session = await start({ promptOutcome: () => outcome });
  try {
    expect(await promptAndWait(session, "hello")).toMatchObject({ kind: "ended", outcome });
    // oxlint-disable-next-line typescript/no-unsafe-assignment, unicorn/prefer-structured-clone -- The persisted JSON representation is under test.
    const records: ReturnType<typeof session.records> = JSON.parse(JSON.stringify(session.records()));
    expect(turnEndAfter(records, -1, session.id)).toEqual(outcome);
    expect(viewOf(records).messages.find((message) => message.kind === "turn")?.outcome).toEqual(outcome);
  } finally { await session.dispose(); }
});

test("Grok forwards schema on prompt, send-now steer and held queue drain", async () => {
  const outputSchema = { type: "object" };
  const { promptMeta, steerParams } = grokAcpProfile;
  if (promptMeta === undefined || steerParams === undefined) { throw new Error("Grok must expose prompt metadata and steer params"); }
  const session = await acpSession(profile({ promptMeta, steerParams,
    steerSupersedesPrompt: true, extensionNotifications: ["fixture/prompt-schema"] }))({ kind: "available", via: "executable", command: process.execPath }, { cwd: process.cwd(), outputSchema });
  try {
    const first = await session.prompt("steer-base");
    await session.queue("queued");
    expect(await session.steer?.("steer-new")).toMatchObject({ kind: "accepted" });
    await awaitTurnEnd(session, first.seq);
    const ended = session.records().find((record) => record.seq > first.seq && record.kind === "frame" && record.body.events.some((event) => event.kind === "turn_ended"));
    expect(ended).toBeDefined();
    await awaitTurnEnd(session, ended?.seq ?? first.seq);
    const sent = session.records().flatMap((record) => record.kind === "frame" && record.body.type === "fixture/prompt-schema"
      ? [asRecord(record.body.native)] : []);
    expect(sent).toHaveLength(3);
    expect(sent.map((params) => asRecord(params?._meta)?.outputSchema)).toEqual([outputSchema, outputSchema, outputSchema]);
    expect(asRecord(sent[1]?._meta)?.sendNow).toBe(true);
  } finally { await session.dispose(); }
});

test("Grok never parses text, preserves falsey native values and prioritizes cancellation", () => {
  expect(grokPromptOutcome({ stopReason: "end_turn" })).toEqual({ kind: "completed" });
  for (const value of [null, false, 0, ""]) {
    expect(grokPromptOutcome({ stopReason: "end_turn", _meta: { structuredOutput: value } })).toEqual({ kind: "completed", structuredOutput: value });
  }
  expect(grokPromptOutcome({ ...reply("valid"), stopReason: "cancelled" })).toEqual({ kind: "aborted" });
});
