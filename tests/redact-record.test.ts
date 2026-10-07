import { expect, test } from "vitest";
import type { RawEvent } from "../packages/oar/src/contracts/records.js";
import { redactRecord } from "../packages/oar/src/observe/index.js";

const frame = (type: string, native: unknown): RawEvent => ({
  kind: "frame",
  sessionId: "s",
  agentPath: [],
  seq: 3,
  receivedAt: 1,
  body: { type, native, events: [] },
});

// The shape oar recorded before 0.32.1 (grok 1.0.46 `_x.ai/mcp/servers_updated`).
const stored = frame("_x.ai/mcp/servers_updated", {
  sessionId: "s",
  mcpServers: [{ name: "userecho", command: "node", env: [{ name: "OAR_ECHO_TOKEN", value: "secret-from-config" }] }],
});

test("a stored grok MCP notification comes back with the credential values redacted, everything else kept", () => {
  const redacted = redactRecord(stored);
  expect(redacted).not.toBe(stored);
  expect(redacted).toEqual(frame("_x.ai/mcp/servers_updated", {
    sessionId: "s",
    mcpServers: [{ name: "userecho", command: "node", env: [{ name: "OAR_ECHO_TOKEN", value: "[redacted]" }] }],
  }));
  expect(JSON.stringify(redacted)).not.toContain("secret-from-config");
  expect(JSON.stringify(stored)).toContain("secret-from-config");
});

test("idempotent: a redacted record, and records no rule touches, come back as the same object", () => {
  const once = redactRecord(stored);
  expect(redactRecord(once)).toBe(once);
  const untouched = frame("session/update", { env: { TOKEN: "not a grok MCP notification" } });
  expect(redactRecord(untouched)).toBe(untouched);
  const status = frame("_x.ai/mcp/server_status", { name: "userecho", status: "connected" });
  expect(redactRecord(status)).toBe(status);
  const request: RawEvent = { kind: "request", id: "r1", direction: "toRuntime", sessionId: "s", agentPath: [], seq: 1, receivedAt: 1, body: { kind: "dispose" } };
  expect(redactRecord(request)).toBe(request);
});
