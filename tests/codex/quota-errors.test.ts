import { expect, test } from "vitest";
import evidence from "../../experiments/codex-quota-errors/selected.json" with { type: "json" };
import { codexFailure } from "../../packages/oar/src/runtimes/codex/failure.js";
import { projectCodexUsage } from "../../packages/oar/src/runtimes/codex/account-usage.js";
import { foldCodexNotification, initialCodexProjection } from "../../packages/oar/src/runtimes/codex/projection.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import type { TurnOutcome } from "../../packages/oar/src/contracts/session.js";

// oxlint-disable-next-line max-statements -- Replay the recorded native order through one projection state.
function replay(row: typeof evidence.rows[number]): TurnOutcome | undefined {
  const id = asRecord(row.notifications.find(n => n.method === "error")?.params)?.threadId;
  if (typeof id !== "string") { throw new TypeError("Recorded native error has no thread"); }
  let state = initialCodexProjection(id);
  const outcomes: TurnOutcome[] = [];
  for (const notification of row.notifications) {
    const { state: next, commands } = foldCodexNotification(state, notification.method, notification.params);
    state = next;
    const events = commands.flatMap(command => command.kind === "frame" ? command.body.events : []);
    outcomes.push(...events.flatMap(event => event.kind === "turn_ended" ? [event.outcome] : []));
  }
  return outcomes.at(-1);
}

// Native Codex 0.169.0 and 0.169.1, loopback provider. Preserve all error and rate-limit fields
// so the stream-loss and stale-compaction cases cannot acquire an inferred reset.
test.each(evidence.rows)("native $version $path $mode account=$account", (row) => {
  const error = row.notifications.find(n => n.method === "error");
  const failure = replay(row);
  const structuredBody = row.mode.startsWith("http400");
  expect(failure).toMatchObject({ kind: "failed", failure: row.mode.startsWith("sse") ? "unknown" : "quota" });
  if (structuredBody || (row.path === "normal" && row.mode === "http-headers")) { expect(failure).toHaveProperty("resetsAt", "2030-03-17T17:46:40.000Z"); }
  else { expect(failure).not.toHaveProperty("resetsAt"); }
  // Both native surfaces carry the same error, including compaction's prefix.
  const completed = row.notifications.findLast(n => n.method === "turn/completed");
  expect(asRecord(asRecord(completed?.params)?.turn)?.error).toEqual(asRecord(error?.params)?.error);
});

test.each(evidence.rows.filter(row => row.account))("live usage after $path $mode", (row) => {
  const before = projectCodexUsage(row.usageBefore);
  const after = projectCodexUsage(row.usageAfter);
  expect(before).toMatchObject({ kind: "available", windows: [{ usedRatio: 0.25, resetsAt: "2030-03-17T16:46:40.000Z" }] });
  expect(after).toMatchObject({ kind: "available", windows: [{ usedRatio: 1, resetsAt: "2030-03-17T17:46:40.000Z" }] });
  if (row.path === "compact") {
    const last = row.notifications.findLast(n => n.method === "account/rateLimits/updated");
    expect(asRecord(last?.params)?.rateLimits).toMatchObject({ primary: { usedPercent: 25, resetsAt: 1_899_996_400 } });
  }
});

test.each([undefined, null, "1900000000", 1e100])("invalid or absent structured reset %s stays absent", (resets_at) => {
  const message = JSON.stringify({ error: { type: "usage_limit_reached", resets_at } });
  expect(codexFailure("native", { codexErrorInfo: "other", message })).toEqual({ kind: "failed", reason: "native", failure: "quota" });
});

test.each([
  "You've hit your usage limit. Try again at 9:00 PM.",
  "Error running remote compact task: You've hit your usage limit. Try again at 9:00 PM.",
  'unrecognized prefix: {"error":{"type":"usage_limit_reached","resets_at":1900000000}}',
  '{"error":{"type":"unrecognized","resets_at":1900000000}}',
])("unstructured or unnamed quota stays unknown: %s", (message) => {
  expect(codexFailure("verbatim reason", { codexErrorInfo: "other", message })).toEqual({ kind: "failed", reason: "verbatim reason", failure: "unknown" });
});
