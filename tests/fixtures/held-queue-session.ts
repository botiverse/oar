/* oxlint-disable import/max-dependencies -- Compose the three real stream-json dialects and the Cursor SDK fixture. */
import { setImmediate as settle } from "node:timers/promises";
import type { AdapterSession, Session } from "../../packages/oar/src/contracts/session.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { sealSession } from "../../packages/oar/src/shared/seal-session.js";
import { createSessionKernel } from "../../packages/oar/src/shared/session-kernel.js";
import { streamJsonSession } from "../../packages/oar/src/shared/stream-json/session.js";
import { claudeProjectionProfile, initialClaudeProjection } from "../../packages/oar/src/runtimes/claude/projection.js";
import { qoderProjectionProfile, initialQoderProjection } from "../../packages/oar/src/runtimes/qoder/projection.js";
import { qwenProjectionProfile, initialQwenProjection } from "../../packages/oar/src/runtimes/qwen/projection.js";
import { fakeLineProcess } from "./fake-line-process.js";
import { openFakeCursor } from "./fake-cursor-sdk.js";

/* oxlint-disable max-statements -- The fixture wires a controlled process, the real dialect, and observable lifecycle helpers. */
/** Real projection dialects over a controlled transport; no account or provider. */
export default async function heldQueueSession(name: "claude" | "qoder" | "qwen" | "cursor") {
  if (name === "cursor") {
    const { session, agent } = await openFakeCursor();
    return { session, agent, written: () => agent.runs.map(run => run.message),
      start: (_id?: string) => {},
      end: async (_id?: string) => { agent.latest().end("finished"); await settle(); },
    };
  }
  const kernel = createSessionKernel("root");
  const child = fakeLineProcess((text, process) => {
    const message = asRecord(parseJson(text));
    if (message?.type === "control_request") { process.emit(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } })}\n`); }
  });
  const adapter: { value?: AdapterSession } = {};
  const credentials = { add: () => {}, values: () => [], redact: (text: string) => text, redactValue: <T>(value: T) => value,
    kernel: () => kernel, seal: (raw: AdapterSession): Session => { adapter.value = raw; return sealSession(raw); } };
  const common = { steer: true, capabilities: { queue: { durable: false }, images: true, attribution: "attributed" as const },
    consume: () => false, open: async () => {}, disposing: () => {}, exited: () => {} };
  const open = async (): Promise<Session> => {
    if (name === "claude") { return streamJsonSession(child, "root", credentials, { ...common, initial: initialClaudeProjection, projection: claudeProjectionProfile }); }
    if (name === "qoder") { return streamJsonSession(child, "root", credentials, { ...common, initial: initialQoderProjection(), projection: qoderProjectionProfile }); }
    return streamJsonSession(child, "root", credentials, { ...common, initial: initialQwenProjection(), projection: qwenProjectionProfile });
  };
  const session = await open();
  const emit = (value: unknown) => { child.emit(`${JSON.stringify(value)}\n`); };
  const start = (id?: string) => { emit(name === "qwen" ? { type: "system", subtype: "init" }
    : { type: "command_lifecycle", command_uuid: id, state: "started" }); };
  return { session, child, adapter: adapter.value, emit, start,
    written: () => child.written.flatMap(text => {
      const value = asRecord(parseJson(text));
      const content = asRecord(value?.message)?.content;
      return value?.type === "user" && Array.isArray(content) ? [content.map(part => asRecord(part)?.text).join("")] : [];
    }),
    end: async (id?: string) => { emit({ type: "result", subtype: "success", is_error: false, ...(id === undefined ? {} : { user_message_uuid: id }) }); await settle(); },
  };
}
