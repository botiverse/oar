/* oxlint-disable max-statements -- Follow one held input through admission, dispatch and replay. */
import { expect, test, vi } from "vitest";
import { createSessionKernel } from "../../packages/oar/src/shared/session-kernel.js";
import { createAcpTurns } from "../../packages/oar/src/shared/acp/turns.js";
import { createUsageUpdateGate } from "../../packages/oar/src/shared/acp/profile.js";
import type { AcpProcess } from "../../packages/oar/src/shared/acp/process.js";
import { initialSessionView, reduceSessionView } from "../../packages/oar/src/observe/session-view.js";
import { profile } from "../fixtures/acp-session-support.js";

test.each([undefined, "11111111-1111-4111-8111-111111111111"])("ACP queue dispatch renders one logical input, inputId: %s", async inputId => {
  const kernel = createSessionKernel("root");
  const send = vi.fn(async () => { await Promise.resolve(); return { stopReason: "end_turn" }; });
  // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- The real turn driver only needs this transport slice for a successful prompt.
  const runtime = { spawned: Promise.resolve(), closed: false, connection: { agent: { request: send } } } as unknown as AcpProcess;
  const turns = createAcpTurns({ kernel, runtime, profile: profile(), usageGate: createUsageUpdateGate(), capabilities: { images: false }, promptUsage: () => null });
  const queued = await kernel.control({ kind: "queue", input: "held", ...(inputId === undefined ? {} : { inputId }) }, async request => turns.hold("held", undefined, inputId, request));
  await vi.waitFor(() => { expect(kernel.records().at(-1)).toMatchObject({ kind: "frame", body: { events: [{ kind: "turn_ended" }] } }); });
  expect(send).toHaveBeenCalledTimes(1);
  const view = kernel.records().reduce((state, record) => reduceSessionView(state, record, "stream"), initialSessionView());
  expect(view.messages.map(message => message.kind)).toEqual(["input", "turn"]);
  const [input] = view.messages;
  expect(input).toMatchObject({ kind: "input", input: { input: "held", state: "accepted", attempts: [{ request: queued.request }, { request: { body: { kind: "prompt", carries: [inputId ?? queued.request.id] } } }] } });
  expect(view.status.kind).toBe("idle");
  expect(kernel.records().filter(record => record.kind === "response" && record.requestId === queued.request.id)).toHaveLength(1);
});
