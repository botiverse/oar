import { expect, test } from "vitest";
import { claudeProjectionProfile, initialClaudeProjection, type ClaudeProjectionState } from "../../packages/oar/src/runtimes/claude/projection.js";
import { withSessionCredentials } from "../../packages/oar/src/shared/session-credentials.js";
import { streamJsonSession } from "../../packages/oar/src/shared/stream-json/session.js";
import type { StreamJsonSessionProfile } from "../../packages/oar/src/shared/stream-json/profile.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const profile: StreamJsonSessionProfile<ClaudeProjectionState> = {
  projection: claudeProjectionProfile,
  initial: initialClaudeProjection,
  capabilities: { queue: { durable: false }, attribution: "attributed", images: false },
  steer: false,
  consume: () => false,
  open: async () => {},
  exited: () => {},
  disposing: () => {},
};
async function open(child: FakeLineProcess, overrides: Partial<typeof profile> = {}) {
  const session = await withSessionCredentials(async (_installation, _options, credentials) =>
    streamJsonSession(child, "session", credentials, { ...profile, ...overrides }))({ kind: "available", via: "executable", command: "fixture", version: "1" }, { cwd: "/work" });
  return session;
}

for (const answer of [{ behavior: "allow", updatedInput: { command: "echo ok" } }, { allowed: true }]) {
  test(`permission reply uses the profile's wire shape: ${JSON.stringify(answer)}`, async () => {
    const child = fakeLineProcess();
    const session = await open(child, { permissionResponse: (id) => ({ type: "control_response", response: { subtype: "success", request_id: id, response: answer } }) });
    try {
      child.emit(`${JSON.stringify({ type: "control_request", request_id: "permission", request: { subtype: "can_use_tool", input: { command: "echo ok" } } })}\n`);
      const reply = { type: "control_response", response: { subtype: "success", request_id: "permission", response: answer } };
      expect(child.written).toEqual([`${JSON.stringify(reply)}\n`]);
      expect(session.records().filter((record) => record.kind === "request")).toMatchObject([{ id: "permission", direction: "toApp", body: { kind: "native", type: "can_use_tool" } }]);
      expect(session.records().filter((record) => record.kind === "response")).toMatchObject([{ requestId: "permission", body: { kind: "accepted", native: reply } }]);
      expect(Object.hasOwn(session, "steer")).toBe(false);
    } finally { await session.dispose(); }
  });
}

test("an absent permission policy preserves Claude's record-only behavior", async () => {
  const child = fakeLineProcess();
  const session = await open(child);
  try {
    child.emit(`${JSON.stringify({ type: "control_request", request_id: "permission", request: { subtype: "can_use_tool" } })}\n`);
    expect(child.written).toEqual([]);
    expect(session.records().filter((record) => record.kind === "request")).toHaveLength(1);
    expect(session.records().filter((record) => record.kind === "response")).toEqual([]);
  } finally { await session.dispose(); }
});

test("frames arriving during private startup keep their projection state", async () => {
  const child = fakeLineProcess();
  const session = await open(child, { open: async () => {
    child.emit(`${JSON.stringify({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call", name: "probe" } } })}\n`);
    await Promise.resolve();
  } });
  try {
    child.emit(`${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } } })}\n`);
    expect(session.records().flatMap((record) => record.kind === "frame" ? record.body.events : [])).toContainEqual({ kind: "tool_call_input_delta", callId: "call", delta: "{}" });
  } finally { await session.dispose(); }
});
