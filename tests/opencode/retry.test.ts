import { expect, it } from "vitest";
import { opencodeRetryEvents } from "../../packages/oar/src/runtimes/opencode/retry.js";
import { opencodeV2AcpProfile } from "../../packages/oar/src/runtimes/opencode/session.js";
import { createAcpRecorder } from "../../packages/oar/src/shared/acp/records.js";
import { createUsageUpdateGate } from "../../packages/oar/src/shared/acp/usage-wait.js";
import { createSessionKernel } from "../../packages/oar/src/shared/session-kernel.js";

const receivedAt = 1_795_082_202_838;
const retry = { attempt: 2, nextRetryAt: "2026-11-19T09:56:45.119Z", error: { type: "provider.internal", message: "private vendor text" } };
const sessionInfo = (value: typeof retry | null) => ({ sessionUpdate: "session_info_update" as const, _meta: { "opencode/retry": value } });

it("replays a 2.3.2 scheduled retry and clear using the arrival time of the buffered frame", () => {
  const recorder = createAcpRecorder(createUsageUpdateGate(), undefined, undefined, undefined, opencodeV2AcpProfile.projectUpdate);
  const kernel = createSessionKernel("root");
  recorder.update({ sessionId: "root", update: sessionInfo(retry) }, receivedAt);
  recorder.update({ sessionId: "root", update: sessionInfo(null) }, receivedAt + 2369);
  recorder.bind(kernel);
  expect(kernel.records().filter(record => record.kind === "frame").map(frame => frame.body.events)).toEqual([
    [{ kind: "retry", attempt: 2, delayMs: 2281, reason: "provider.internal" }], [],
  ]);
});

it("keeps the native attempt, clamps elapsed waits and omits unavailable delay or error category", () => {
  expect(opencodeRetryEvents(sessionInfo(retry), receivedAt + 3000)).toMatchObject([{ delayMs: 0 }]);
  expect(opencodeRetryEvents(sessionInfo({ ...retry, nextRetryAt: "invalid", error: { type: "", message: "private" } }), receivedAt)).toEqual([{ kind: "retry", attempt: 2 }]);
  expect(opencodeRetryEvents(sessionInfo({ ...retry, attempt: 0 }), receivedAt)).toEqual([]);
  expect(opencodeRetryEvents({ ...sessionInfo(retry), sessionUpdate: "agent_message_chunk" }, receivedAt)).toEqual([]);
});
